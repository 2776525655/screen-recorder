const { app, ipcMain, dialog, desktopCapturer, screen, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
  } catch (_) {
    return {}
  }
}

function writeSettings(patch) {
  const s = readSettings()
  Object.assign(s, patch)
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), 'utf8')
  } catch (_) {}
}

/** 保存目录：设置里填什么就用什么（不存在则自动创建）；完全未设置才用默认 D:\录屏 */
function getSaveDir() {
  const custom = readSettings().saveDir
  if (custom && typeof custom === 'string' && custom.trim()) {
    // 以设置里的路径为准：目录不存在就自动创建，创建成功即生效
    try {
      fs.mkdirSync(custom, { recursive: true })
      if (fs.existsSync(custom)) return custom
    } catch (_) {}
  }
  // 未设置或创建失败时回退默认：
  // 便携版 → exe 同目录/录像；普通版 → D:\录屏；都不可用 → 系统视频目录
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    const pd = path.join(process.env.PORTABLE_EXECUTABLE_DIR, '录像')
    try {
      fs.mkdirSync(pd, { recursive: true })
    } catch (_) {}
    if (fs.existsSync(pd)) return pd
  }
  const def = 'D:\\录屏'
  try {
    fs.mkdirSync(def, { recursive: true })
  } catch (_) {}
  if (fs.existsSync(def)) return def
  return path.join(app.getPath('videos'), '录屏')
}

function tempDir() {
  return path.join(app.getPath('temp'), 'screenrec-cache')
}

function allocTempFile() {
  fs.mkdirSync(tempDir(), { recursive: true })
  return path.join(tempDir(), `rec_${Date.now()}_${Math.floor(Math.random() * 10000)}.mp4`)
}

function cleanupTempDir() {
  try {
    if (fs.existsSync(tempDir())) fs.rmSync(tempDir(), { recursive: true, force: true })
  } catch (_) {}
}

function BrowserWindowOf(e) {
  const { BrowserWindow } = require('electron')
  return BrowserWindow.fromWebContents(e.sender)
}

/**
 * 注册全部 IPC。
 * @param opts { setState } 手动录制状态/计时上报回调
 */
function registerIpc({ setState } = {}) {
  ipcMain.on('win:min', (e) => BrowserWindowOf(e)?.minimize())
  ipcMain.on('win:close', (e) => BrowserWindowOf(e)?.close())
  ipcMain.handle('win:max', (e) => {
    const win = BrowserWindowOf(e)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })

  // 手动录制状态上报（录制关闭保护 + 悬浮条驱动）
  ipcMain.on('state:change', (_e, payload) => {
    if (setState) setState(payload || {})
  })

  // 枚举录制源（widget 只显示名称，不抓缩略图，降低每次打开面板的延迟与资源占用）
  ipcMain.handle('sources:list', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
    const displays = screen.getAllDisplays()
    return sources
      .filter((s) => s.name.trim().length > 0)
      .map((s) => {
        const isScreen = s.id.startsWith('screen')
        const disp = isScreen ? displays.find((d) => String(d.id) === String(s.display_id)) : null
        return {
          id: s.id,
          name: s.name,
          type: isScreen ? 'screen' : 'window',
          thumbnail: null,
          bounds: disp ? { x: disp.bounds.x, y: disp.bounds.y, width: disp.bounds.width, height: disp.bounds.height } : null,
        }
      })
  })

  // —— 录屏临时文件（WebCodecs 边编码边写盘） ——
  ipcMain.handle('rec:temp-create', () => {
    const filePath = allocTempFile()
    try {
      fs.writeFileSync(filePath, '') // 创建空文件，供后续按偏移写入（r+）
    } catch (_) {}
    return { filePath }
  })

  // mp4-muxer 会回头改写文件头/索引（随机位置写入），必须支持按 offset 写，
  // 只追加会导致 moov 索引丢失、成片无法播放。
  ipcMain.handle('rec:temp-append', (_e, { filePath, offset, data }) => {
    try {
      const buf =
        data instanceof Uint8Array
          ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
          : Buffer.from(data)
      const fd = fs.openSync(filePath, 'r+')
      try {
        const off =
          typeof offset === 'number' && offset >= 0 ? offset : fs.statSync(filePath).size
        fs.writeSync(fd, buf, 0, buf.length, off)
      } finally {
        fs.closeSync(fd)
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err.message }
    }
  })

  ipcMain.handle('rec:temp-stat', (_e, { filePath }) => {
    try {
      return { ok: true, size: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0 }
    } catch (_) {
      return { ok: false, size: 0 }
    }
  })

  // 校验文件是否已写入完整 mp4 索引（moov 在尾部），避免收尾竞态复制出残缺文件
  ipcMain.handle('rec:temp-has-moov', (_e, { filePath }) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return { ok: false, hasMoov: false }
      const buf = fs.readFileSync(filePath)
      return { ok: true, hasMoov: buf.includes(Buffer.from('moov')) }
    } catch (_) {
      return { ok: false, hasMoov: false }
    }
  })

  ipcMain.handle('rec:temp-remove', (_e, { filePath }) => {
    try {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath)
    } catch (_) {}
    return { ok: true }
  })

  // 调试留存：录制停止后保留一份原始 mp4，供诊断"无法播放"类问题
  ipcMain.handle('rec:debug-retain', (_e, { filePath }) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return { ok: false }
      const dir = path.join(app.getPath('temp'), 'screenrec-dbg')
      fs.mkdirSync(dir, { recursive: true })
      const name = `rec_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`
      fs.copyFileSync(filePath, path.join(dir, name))
      return { ok: true, name }
    } catch (_) {
      return { ok: false }
    }
  })

  // 保存：自动保存到默认目录（不再弹对话框，Xbox 式一键落盘）
  ipcMain.handle('rec:temp-save', (_e, { filePath, suggestedName }) => {
    if (!filePath || !fs.existsSync(filePath)) return { saved: false, reason: 'empty' }
    const dir = getSaveDir()
    try {
      fs.mkdirSync(dir, { recursive: true })
      const target = path.join(dir, suggestedName || '录屏.mp4')
      const same = path.resolve(target).toLowerCase() === path.resolve(filePath).toLowerCase()
      if (!same) fs.copyFileSync(filePath, target)
      fs.unlinkSync(filePath)
      const size = fs.statSync(target).size
      return { saved: true, path: target, size }
    } catch (err) {
      return { saved: false, reason: 'write-error', message: err.message }
    }
  })

  // —— 默认保存目录 ——
  ipcMain.handle('save:get-dir', () => ({ dir: getSaveDir() }))
  ipcMain.handle('save:choose-dir', async (e) => {
    const win = BrowserWindowOf(e)
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '选择默认保存文件夹',
      defaultPath: getSaveDir(),
      properties: ['openDirectory', 'createDirectory'],
    })
    if (canceled || !filePaths || !filePaths.length) return { changed: false, dir: getSaveDir() }
    writeSettings({ saveDir: filePaths[0] })
    return { changed: true, dir: filePaths[0] }
  })

  // 通用文件夹选择（只返回路径不写设置，供回放缓存位置等使用）
  ipcMain.handle('dir:choose', async (e) => {
    const win = BrowserWindowOf(e)
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '选择文件夹',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (canceled || !filePaths || !filePaths.length) return { dir: null }
    return { dir: filePaths[0] }
  })

  // 在资源管理器中显示文件
  ipcMain.handle('path:show', (_e, filePath) => {
    if (filePath) shell.showItemInFolder(filePath)
    return { ok: true }
  })

  // 打开 Windows 声音设置面板（立体声混音引导用）
  ipcMain.handle('sound:panel', () => {
    try {
      const { spawn } = require('node:child_process')
      spawn('control.exe', ['mmsys.cpl'], { detached: true, windowsHide: true }).unref()
      return { ok: true }
    } catch (_) {
      return { ok: false }
    }
  })

  // 磁盘剩余空间（参考开源录屏工具的开盘空间告警做法）
  ipcMain.handle('disk:free', (_e, p) => {
    try {
      const fsMod = require('node:fs')
      if (typeof fsMod.statfsSync !== 'function') return { ok: false }
      const dir = p || getSaveDir()
      const st = fsMod.statfsSync(dir)
      return { ok: true, free: st.bavail * st.bsize }
    } catch (_) {
      return { ok: false }
    }
  })
}

module.exports = {
  registerIpc,
  cleanupTempDir,
  getSaveDir,
  readSettings,
  writeSettings,
  BrowserWindowOf,
}
