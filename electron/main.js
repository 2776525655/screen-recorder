const { app, BrowserWindow, ipcMain, dialog, session, Tray, Menu, nativeImage, screen, globalShortcut, Notification } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const { registerIpc, cleanupTempDir } = require('./ipc')
const { ReplayEngine } = require('./engine/replay')
const { CursorSource } = require('./cursor')

// 限制每个渲染进程的 V8 堆上限，并暴露 GC，让采集页/Widget 主动回收内存，
// 避免长时间运行时 working set 缓慢膨胀
try {
  app.commandLine.appendSwitch('js-flags', '--expose-gc --max-old-space-size=256 --max-semi-space-size=16')
} catch (_) {}

// 便携绿色模式：数据全部跟随 portable exe 所在目录（<exe目录>/Data），
// 不写 C 盘 AppData——设置、分段缓存、默认成片都在这一个文件夹里。
// 安装版(Setup/win-unpacked)无该环境变量，保持原有系统目录行为。
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  try {
    app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'Data'))
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
  } catch (_) {}
}

// 后台常驻模式：开机自启带 --hidden，不创建 UI 窗口，仅托盘 + 自动记忆回放（Xbox 式）
const AUTO_HIDDEN = process.argv.includes('--hidden')
// 注意：不能禁用硬件加速——DXGI 桌面采集与 H.264 编码依赖 GPU/加速管线

let widgetWindow = null
let settingsWindow = null
let tray = null
let quitting = false

// 单实例锁
let isPrimary = app.requestSingleInstanceLock()
if (!isPrimary) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showWidget()
  })
}

// 手动录制状态（widget 状态来源）
const manual = { state: 'idle', elapsed: 0, micMuted: false }
const CLOSE_BLOCK_STATES = ['recording', 'paused', 'saving']

// 记忆回放引擎
const replayEngine = new ReplayEngine({ root: app.getAppPath() })
// 磁盘分段缓存（每 2s 一段独立 mp4，仅保留最近 keepSec，内存恒定）
let replaySegs = [] // { file, startUs, endUs }
let replayPruneTimer = null
let replayExportBusy = false // 拼接期间暂停清理，防止读到半删文件
/** 分段缓存目录：默认 C 盘用户数据；设置里可改到别的盘。
 *  始终使用所选目录下的独立子目录 screenrec-replay-cache，避免误清用户文件 */
function replayCachePath() {
  const s = readSettingsObj()
  if (s && s.replayCacheDir && typeof s.replayCacheDir === 'string' && s.replayCacheDir.trim()) {
    return path.join(s.replayCacheDir.trim(), 'screenrec-replay-cache')
  }
  return path.join(app.getPath('userData'), 'replay-cache')
}
function clearReplayCacheDir() {
  try {
    fs.rmSync(replayCachePath(), { recursive: true, force: true })
  } catch (_) {}
}

// —— 工具 ——
function ffmpegExePath() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'ffmpeg.exe') : '',
    path.join(app.getAppPath(), 'bin', 'ffmpeg.exe'),
  ]
  for (const c of candidates) if (c && fs.existsSync(c)) return c
  return 'ffmpeg'
}

// —— 开机自启动（后台 --hidden 常驻） ——
function applyAutoStart(enabled) {
  try {
    const args = []
    if (!app.isPackaged) args.push(app.getAppPath()) // 开发模式：electron.exe + 应用目录
    args.push('--hidden')
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args,
      name: '屏刻 ScreenRec',
    })
  } catch (_) {}
}

function isAutoStartOn() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'))
    return !!s.autoStart
  } catch (_) {
    return false
  }
}

function setAutoStart(v) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    const p = path.join(app.getPath('userData'), 'settings.json')
    const cur = (() => {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return {} }
    })()
    fs.writeFileSync(p, JSON.stringify({ ...cur, autoStart: !!v }, null, 2), 'utf8')
  } catch (_) {}
  applyAutoStart(!!v)
  refreshTrayMenu()
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('settings:changed')
  }
}

function fmtDur(sec) {
  const s = Math.max(0, Math.floor(sec))
  const m = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${m}:${ss}`
}

function notice(message, type = 'info') {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send('app:notice', { message, type })
  } else {
    // 无窗口（后台常驻/收进托盘）时用系统通知提示
    try {
      new Notification({
        title: type === 'error' ? '屏刻 · 出错' : '屏刻 ScreenRec',
        body: message,
      }).show()
    } catch (_) {}
  }
}

function sendCmd(action, payload) {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send('recorder:cmd', action, payload)
  }
}

function pushWidgetState() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  widgetWindow.webContents.send('widget:state', {
    recording: manual.state,
    elapsed: manual.elapsed,
    replay: replayEngine.running
      ? { on: true, buffered: replayEngine.bufferedSec(), keep: replayEngine.keepSec }
      : { on: false, buffered: 0, keep: 180 },
  })
}

function onManualState(payload) {
  manual.state = payload.state || 'idle'
  manual.elapsed = payload.elapsed || 0
  manual.micMuted = !!payload.micMuted
  pushWidgetState()
  refreshCursorPolling()
}

// —— 记忆回放（DXGI 内存环形缓冲引擎） ——
let captureWin = null
let captureReady = false
let pendingStartCfg = null
let exportResolver = null
const cursorSource = new CursorSource()
let cursorPolling = false
let lastMetaAt = 0

function replayState() {
  return {
    on: replayEngine.running,
    buffered: replayEngine.bufferedSec(),
    keep: replayEngine.keepSec,
    audioOn: replayEngine.audioOn,
  }
}

function stopPruneLoop() {
  if (replayPruneTimer) {
    clearInterval(replayPruneTimer)
    replayPruneTimer = null
  }
}

// —— 内存看护：总占用超过阈值时做轻量回收，不影响记忆录屏缓冲 ——
const MEM_TRIM_MB = 150 // 用户要求：超过 150MB 自动回收
let memWatchTimer = null
let lastMemTrimAt = 0
let lastTrimTotal = 0
/** 调用 Windows EmptyWorkingSet 把所有 Electron 进程的不活跃工作集页踢回页面文件
 *  等价于"电脑管家一键加速"——效果立竿见影，对记忆录屏画面几乎无影响（异步执行不阻塞主进程） */
function trimWorkingSet() {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok) => {
      if (!done) {
        done = true
        resolve(ok)
      }
    }
    try {
      const cp = spawn(
        'powershell',
        [
          '-NoProfile', '-NonInteractive',
          '-Command',
          [
            "Add-Type -TypeDefinition @\"using System; using System.Diagnostics; using System.Runtime.InteropServices; public class WSet { [DllImport(\"kernel32.dll\")] public static extern bool SetProcessWorkingSetSize(IntPtr h, IntPtr m, IntPtr x); public static void Trim(int pid){ try { var p=Process.GetProcessById(pid); SetProcessWorkingSetSize(p.Handle,(IntPtr)(-1),(IntPtr)(-1)); } catch {} } }\"@",
            "Get-Process electron -ErrorAction SilentlyContinue | ForEach-Object { [WSet]::Trim($_.Id) }",
          ].join(' '),
        ],
        { windowsHide: true, stdio: 'ignore' },
      )
      cp.once('error', () => finish(false))
      cp.once('exit', (code) => finish(code === 0))
      setTimeout(() => {
        if (!done) {
          try { cp.kill() } catch (_) {}
          finish(false)
        }
      }, 8000)
    } catch (_) {
      finish(false)
    }
  })
}
function startMemWatch() {
  if (memWatchTimer) return
  memWatchTimer = setInterval(() => {
    let total = 0
    try {
      for (const m of app.getAppMetrics()) {
        if (m && m.workingSetSize) total += m.workingSetSize
      }
    } catch (_) {}
    const mb = Math.round(total / 1024 / 1024)
    if (mb <= MEM_TRIM_MB) {
      lastTrimTotal = mb
      return
    }
    // 超阈值 → 轻度回收（仅当上一轮已回落，避免连续反复 trim）
    const now = Date.now()
    if (now - lastMemTrimAt < 10_000) return
    lastMemTrimAt = now
    lastTrimTotal = mb
    try {
      // 1) 采集页主动 GC（V8 堆回收，缓冲在磁盘上不受影响）
      bgSend('gc')
      // 2) 前台 widget 页面也回收一次
      if (widgetWindow && !widgetWindow.isDestroyed()) {
        widgetWindow.webContents.send('recorder:cmd', '__gc__')
      }
      // 3) 清 HTTP 会话缓存，释放网络进程占用
      try {
        session.defaultSession.clearCache()
      } catch (_) {}
      // 4) EmptyWorkingSet：把所有 Electron 进程的工作集踢回页面文件
      //    （等价"电脑管家一键加速"——效果立竿见影，对记忆录屏画面几乎无影响）
      trimWorkingSet().then((wsOk) => {
        logSave(`MEMTRIM total=${mb}MB wsOk=${wsOk} segs=${replaySegs.length} replay=${replayEngine.running}`)
      })
      // 5) 隔 600ms 再补一轮 GC
      setTimeout(() => bgSend('gc'), 600)
    } catch (_) {}
  }, 12000)
}

function startReplayPruneLoop() {
  stopPruneLoop()
  pruneReplaySegs()
  replayPruneTimer = setInterval(pruneReplaySegs, 5000)
}

/** 磁盘只保留最近 keepSec 的段文件（相对最新段时间，避免跨时钟差异） */
function pruneReplaySegs() {
  if (replayExportBusy) return
  if (!replaySegs.length) return
  const keepUs = (replayEngine.keepSec || 180) * 1e6
  const lastEnd = replaySegs[replaySegs.length - 1].endUs
  while (replaySegs.length > 1 && lastEnd - replaySegs[0].startUs > keepUs + 1e6) {
    const old = replaySegs.shift()
    try {
      fs.unlinkSync(old.file)
    } catch (_) {}
  }
}

function bgSend(type, payload) {
  if (captureWin && !captureWin.isDestroyed() && captureReady) {
    captureWin.webContents.send('bg:cmd', { type, ...(payload || {}) })
    return true
  }
  return false
}

function readSettingsObj() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'))
  } catch (_) {
    return {}
  }
}

/** 隐藏采集窗口：极小、置于工作区右下角，仅用于让视频帧正常合成（不干扰操作） */
function ensureCaptureWindow() {
  if (captureWin && !captureWin.isDestroyed()) return captureWin
  captureReady = false
  const wa = screen.getPrimaryDisplay().workArea
  captureWin = new BrowserWindow({
    width: 10,
    height: 10,
    x: wa.x + wa.width - 12,
    y: wa.y + wa.height - 12,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: true,
    alwaysOnTop: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })
  captureWin.loadFile(path.join(app.getAppPath(), 'dist', 'capture.html'))
  captureWin.webContents.once('did-finish-load', () => {
    captureReady = true
    if (pendingStartCfg) {
      const c = pendingStartCfg
      pendingStartCfg = null
      sendReplayStartCfg(c)
    }
  })
  captureWin.on('closed', () => {
    captureWin = null
    captureReady = false
  })
  return captureWin
}

function destroyCaptureWindow() {
  if (cursorPolling) {
    cursorSource.stop()
    cursorPolling = false
  }
  if (captureWin && !captureWin.isDestroyed()) captureWin.destroy()
  captureWin = null
  captureReady = false
}

async function primaryScreenSourceInfo() {
  const { desktopCapturer } = require('electron')
  const displays = screen.getAllDisplays()
  const prim = displays.find((d) => d.isPrimary) || displays[0]
  const list = await desktopCapturer.getSources({ types: ['screen'] })
  const src =
    list.find((s) => String(s.display_id) === String(prim && prim.id)) ||
    list.find((s) => s.id.startsWith('screen')) ||
    list[0]
  const sf = (prim && prim.scaleFactor) || 1
  const ox = prim ? Math.round(prim.bounds.x * sf) : 0
  const oy = prim ? Math.round(prim.bounds.y * sf) : 0
  return { sourceId: src ? src.id : '', sourceX: ox, sourceY: oy }
}

function cursorOnSetting() {
  return readSettingsObj().cursorOn !== false
}

function broadcastCursor(x, y) {
  const obj = { type: 'cursor', x, y }
  if (captureWin && !captureWin.isDestroyed()) {
    captureWin.webContents.send('bg:cmd', obj)
  }
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send('recorder:cursor', { x, y })
  }
}

/** 只要「记忆回放在录」或「手动录屏中」且开启了录鼠标，就启动光标轮询 */
function refreshCursorPolling() {
  const want =
    cursorOnSetting() && (replayEngine.running || manual.state === 'recording' || manual.state === 'paused')
  if (want) {
    if (!cursorPolling) {
      cursorPolling = true
      cursorSource.start((x, y) => broadcastCursor(x, y), 50)
    }
  } else if (cursorPolling) {
    cursorPolling = false
    cursorSource.stop()
  }
}

async function sendReplayStartCfg(cfg) {
  if (!captureReady) {
    pendingStartCfg = cfg
    ensureCaptureWindow()
    return
  }
  try {
    const info = await primaryScreenSourceInfo()
    const st = readSettingsObj()
    const cursorOn = st.cursorOn !== false
    bgSend('start', {
      fps: cfg.fps || 12,
      keepSec: cfg.keepSec || 180,
      bitrate: cfg.bitrate || 5_000_000,
      cursorOn,
      cacheDir: cfg.cacheDir || '',
      sourceId: info.sourceId,
      sourceX: info.sourceX,
      sourceY: info.sourceY,
    })
    refreshCursorPolling()
  } catch (e) {
    notice('记忆回放启动失败：' + (e && e.message), 'error')
  }
}

function registerBgIpc() {
  ipcMain.removeAllListeners('bg:ready')
  ipcMain.removeAllListeners('bg:log')
  ipcMain.removeAllListeners('bg:meta')
  try { ipcMain.removeHandler('bg:mkfile') } catch (_) {}
  ipcMain.on('bg:ready', () => {})
  ipcMain.on('bg:log', (_e, msg) => {
    try {
      fs.appendFileSync(path.join(app.getPath('temp'), 'screenrec-bg.log'), `${new Date().toISOString()} ${String(msg)}\n`)
    } catch (_) {}
  })
  ipcMain.on('bg:meta', (_e, d) => {
    if (!d) return
    if (d.type === 'state') {
      replayEngine.setMeta(!!d.active, d.bufferedSec || 0, d.error || '')
      if (d.error && replayEngine._notified !== d.error) {
        replayEngine._notified = d.error
        notice('记忆回放已停止：' + d.error, 'error')
      }
      const now = Date.now()
      if (now - lastMetaAt > 1000) {
        lastMetaAt = now
        refreshTrayMenu()
        pushWidgetState()
      }
    } else if (d.type === 'seg') {
      // 一段已落盘：登记并按 keep 窗口清理过期段文件
      if (d.file && typeof d.startUs === 'number') {
        replaySegs.push({ file: d.file, startUs: d.startUs, endUs: d.endUs || d.startUs })
        pruneReplaySegs()
      }
    } else if (d.type === 'export-done') {
      if (exportResolver) {
        const r = exportResolver
        exportResolver = null
        r({ ok: !!d.ok, audioPath: d.audioPath || null, message: d.message || '' })
      }
    }
  })
  ipcMain.handle('bg:mkfile', (_e, { filePath }) => {
    try {
      if (!filePath) return { ok: false, message: '路径为空' }
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, '')
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err.message }
    }
  })
}

/** ffmpeg 把最近 keepSec 的磁盘段拼成视频文件；返回路径或 null */
async function assembleReplayVideo() {
  if (!replaySegs.length) return null
  pruneReplaySegs()
  if (!replaySegs.length) return null
  const tmpDir = path.join(app.getPath('temp'), 'screenrec-cache')
  fs.mkdirSync(tmpDir, { recursive: true })
  const base = `replay_${Date.now()}`
  const listPath = path.join(tmpDir, base + '.txt')
  const mergedV = path.join(tmpDir, base + '_v.mp4')
  const esc = (p) => p.replace(/'/g, "'\\''")
  fs.writeFileSync(listPath, replaySegs.map((s) => `file '${esc(s.file)}'`).join('\n'), 'utf8')
  let ok = await runFfmpegOk([
    '-y', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0',
    '-i', listPath,
    '-map', '0:v', '-c:v', 'copy', mergedV,
  ])
  if (!ok) {
    // 兜底：个别段格式不符时重编码（仍很快）
    ok = await runFfmpegOk([
      '-y', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0',
      '-i', listPath,
      '-map', '0:v', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', mergedV,
    ])
  }
  try { fs.unlinkSync(listPath) } catch (_) {}
  if (!ok || !fs.existsSync(mergedV) || fs.statSync(mergedV).size === 0) {
    try { fs.unlinkSync(mergedV) } catch (_) {}
    return null
  }
  return mergedV
}

/** 保存失败/过程日志，方便定位（路径、ffmpeg 退出码等） */
function logSave(msg) {
  try {
    const f = path.join(app.getPath('temp'), 'screenrec-save.log')
    fs.appendFileSync(f, `${new Date().toISOString()} ${String(msg)}\n`)
  } catch (_) {}
}

/** 把最近一次保存的错误详情写到保存目录（用户打开文件夹即可看到），便于排查 */
function writeSaveDebug(msg) {
  try {
    logSave(msg)
    const { getSaveDir } = require('./ipc')
    const dir = getSaveDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, '_screenrec_save_debug.log'),
      `${new Date().toISOString()} ${String(msg)}\n`,
      'utf8',
    )
  } catch (_) {}
}

async function saveReplayAuto() {
  try {
    const { getSaveDir } = require('./ipc')
    const dir0 = getSaveDir()
    writeSaveDebug('BEGIN segs=' + replaySegs.length + ' running=' + replayEngine.running + ' saveDir=' + dir0)
    if (!replayEngine.running && replaySegs.length === 0) {
      writeSaveDebug('EMPTY: 回放未运行且无磁盘段（请确认状态栏有「缓冲」计时）')
      return { saved: false, reason: 'empty', message: '回放缓冲为空：请确认状态栏有「缓冲 xx/xx」走动后再保存' }
    }
    replayExportBusy = true
    // 1) 让采集页把当前 2 秒段完整落盘并导出麦克风音轨（<1s）
    const ex = await replayEngine.saveReplay('')
    writeSaveDebug('EXPORT ok=' + ex.ok + ' msg=' + (ex.message || '') + ' segs=' + replaySegs.length)
    if (!ex.ok) {
      writeSaveDebug('EXPORT_FAIL: ' + (ex.message || '采集页未回应'))
      return { saved: false, reason: 'convert-error', message: '导出失败：' + ((ex.message || '采集页未回应，请重试')) }
    }
    // 2) 拼接磁盘段为视频（-c copy 无损，秒级）
    const mergedV = await assembleReplayVideo()
    if (!mergedV) {
      writeSaveDebug('ASSEMBLE_FAIL: 无可用画面段（segs=' + replaySegs.length + '）ffmpeg 拼接失败')
      return { saved: false, reason: 'convert-error', message: '画面拼接失败：没有可用的缓冲画面，请确认回放正在缓冲后重试' }
    }
    // 3) 若有麦克风音轨则并入
    const tmpDir = path.dirname(mergedV)
    const vaPath = path.join(tmpDir, `replay_${Date.now()}_va.mp4`)
    let videoPath = mergedV
    if (ex.audioPath) {
      const okA = await runFfmpegOk([
        '-y', '-loglevel', 'error',
        '-i', mergedV, '-i', ex.audioPath,
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', vaPath,
      ])
      try { fs.unlinkSync(ex.audioPath) } catch (_) {}
      if (okA) videoPath = vaPath
    }
    // 4) 落到保存目录；有系统声则混入
    const dir = dir0
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, replayFileName())
    writeSaveDebug('TARGET ' + target)
    const merged = await mergeSysAudio(videoPath, target)
    if (!merged) fs.copyFileSync(videoPath, target)
    for (const f of [mergedV, vaPath]) {
      try { fs.unlinkSync(f) } catch (_) {}
    }
    const size = fs.statSync(target).size
    writeSaveDebug('OK size=' + size + ' path=' + target)
    return { saved: true, path: target, size }
  } catch (err) {
    writeSaveDebug('ERR ' + (err && err.stack ? err.stack : err))
    return { saved: false, reason: 'error', message: '保存失败：' + ((err && err.message) || String(err)) }
  } finally {
    replayExportBusy = false
  }
}

async function startReplay({ keepSec, fps, bitrate }) {
  if (CLOSE_BLOCK_STATES.includes(manual.state)) {
    return { ok: false, message: '正在手动录制，请先停止后再开启记忆回放' }
  }
  // 全新一轮：清空上次遗留缓存段
  clearReplayCacheDir()
  replaySegs = []
  fs.mkdirSync(replayCachePath(), { recursive: true })
  ensureCaptureWindow()
  const res = await replayEngine.start({ keepSec, fps, bitrate })
  sendReplayStartCfg({ keepSec, fps, bitrate, cacheDir: replayCachePath() })
  // 系统声音旁路（检测不到立体声混音则自动忽略）
  startSysAudio(keepSec || 180)
  startReplayPruneLoop()
  refreshTrayMenu()
  pushWidgetState()
  return res
}

async function stopReplay() {
  await replayEngine.stop()
  stopSysAudio()
  if (captureWin) bgSend('stop')
  stopPruneLoop()
  refreshCursorPolling()
  refreshTrayMenu()
  pushWidgetState()
  // 稍后回收隐藏窗口并清空磁盘分段，让内存/磁盘回到最低
  setTimeout(() => {
    if (!replayEngine.running) {
      destroyCaptureWindow()
      clearReplayCacheDir()
      replaySegs = []
    }
  }, 800)
  return { ok: true }
}

/** 从设置读取回放参数（设置是什么就用什么，不做自动降档） */
function replayCfgFromSettings() {
  let keepMin = 3
  let replayQuality = '1080p'
  let replayFps = 12
  try {
    const s = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'))
    if (s && s.keepMin) keepMin = s.keepMin
    if (s && s.replayQuality) replayQuality = s.replayQuality
    if (s && s.replayFps) replayFps = s.replayFps
  } catch (_) {}
  const base = { original: 7_000_000, '1080p': 5_500_000, '720p': 3_500_000 }
  const baseRate = base[replayQuality] == null ? 5_500_000 : base[replayQuality]
  const bitrate = Math.round(baseRate * Math.max(1, (Number(replayFps) || 12) / 12))
  return { keepSec: keepMin * 60, fps: Number(replayFps) || 12, bitrate }
}

function startReplayFromSettings() {
  return startReplay(replayCfgFromSettings())
}

async function toggleReplayEngine() {
  if (replayEngine.running) return stopReplay()
  return startReplayFromSettings()
}

// 引擎钩子：采集窗口启停/导出
replayEngine.setHooks({
  onStart(cfg) {
    /* 采集启动由 startReplay() 触发 sendReplayStartCfg */
    void cfg
  },
  onStop() {
    cursorPolling = false
    cursorSource.stop()
    if (captureWin) bgSend('stop')
  },
  onExport(filePath) {
    return new Promise((resolve) => {
      exportResolver = resolve
      if (!bgSend('export', { filePath })) {
        const r = exportResolver
        exportResolver = null
        r({ ok: false, message: '采集引擎未就绪' })
        return
      }
      setTimeout(() => {
        if (exportResolver) {
          const r = exportResolver
          exportResolver = null
          r({ ok: false, message: '导出超时' })
        }
      }, 30_000)
    })
  },
})

function replayFileName() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `录屏_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.mp4`
}

// —— 系统声音旁路（立体声混音 → 2 秒 wav 小段） ——
const sysAudioState = { proc: null, dir: '', timer: null, segSeconds: 2 }

function sysCacheDir() {
  return path.join(app.getPath('temp'), 'screenrec-sys')
}

function listSysSegs() {
  try {
    if (!sysAudioState.dir || !fs.existsSync(sysAudioState.dir)) return []
    return fs
      .readdirSync(sysAudioState.dir)
      .filter((f) => /^seg_\d+\.wav$/.test(f))
      .map((f) => path.join(sysAudioState.dir, f))
      .sort()
  } catch (_) {
    return []
  }
}

function pruneSysSegs(keepSec) {
  const segs = listSysSegs()
  const max = Math.max(1, Math.ceil((keepSec || 180) / sysAudioState.segSeconds) + 1)
  while (segs.length > max) {
    const old = segs.shift()
    try { fs.unlinkSync(old) } catch (_) {}
  }
}

function stopSysAudio() {
  if (sysAudioState.timer) {
    clearInterval(sysAudioState.timer)
    sysAudioState.timer = null
  }
  if (sysAudioState.proc && sysAudioState.proc.exitCode === null) {
    try { sysAudioState.proc.kill() } catch (_) {}
  }
  sysAudioState.proc = null
}

async function startSysAudio(keepSec) {
  stopSysAudio()
  const st = readSettingsObj()
  if (st.replaySysAudio === false) return false
  const ff = ffmpegExePath()
  if (!ff || ff === 'ffmpeg') return false
  const dir = sysCacheDir()
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
  } catch (_) {
    return false
  }
  const candidates = ['立体声混音', 'Stereo Mix']
  for (const dev of candidates) {
    const args = [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'dshow', '-i', `audio=${dev}`,
      '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le',
      '-f', 'segment', '-segment_time', '2', '-reset_timestamps', '1',
      path.join(dir, 'seg_%03d.wav'),
    ]
    const ok = await new Promise((resolve) => {
      let settled = false
      let p = null
      try {
        p = spawn(ff, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] })
      } catch (_) {
        resolve(false)
        return
      }
      p.once('error', () => {
        if (!settled) { settled = true; resolve(false) }
      })
      p.once('exit', () => {
        if (!settled) { settled = true; resolve(false) }
      })
      setTimeout(() => {
        if (!settled && p && p.exitCode === null) {
          settled = true
          sysAudioState.proc = p
          resolve(true)
        }
      }, 1600)
    })
    if (ok) {
      sysAudioState.dir = dir
      sysAudioState.timer = setInterval(() => pruneSysSegs(keepSec), 4000)
      return true
    }
  }
  sysAudioState.dir = dir
  sysAudioState.timer = setInterval(() => pruneSysSegs(keepSec), 4000)
  return false
}

function runFfmpegOk(args) {
  return new Promise((resolve) => {
    const ff = ffmpegExePath()
    if (!ff || ff === 'ffmpeg') return resolve(false)
    let p = null
    try {
      p = spawn(ff, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (_) {
      return resolve(false)
    }
    let err = ''
    p.stderr.setEncoding('utf8')
    p.stderr.on('data', (d) => {
      err = (err + String(d)).slice(-400)
    })
    p.once('error', (e) => {
      logSave('FFMPEG spawn error ' + (e && e.message) + ' args=' + JSON.stringify(args).slice(0, 300))
      resolve(false)
    })
    p.once('exit', (code) => {
      const outOk = code === 0 && fs.existsSync(args[args.length - 1]) && fs.statSync(args[args.length - 1]).size > 0
      if (!outOk) logSave('FFMPEG exit=' + code + ' err=' + err + ' args=' + JSON.stringify(args).slice(0, 300))
      resolve(outOk)
    })
  })
}

/** 把最近系统声 wav 段混入视频文件；失败返回 false（调用方回退为纯视频） */
async function mergeSysAudio(videoPath, outPath) {
  try {
    const segs = listSysSegs()
    if (!segs.length) return false
    const base = path.dirname(videoPath)
    const wavTmp = path.join(base, `sys_${Date.now()}.wav`)
    const concatInputs = []
    const concatMap = []
    const sysCount = Math.max(1, Math.ceil((replayEngine.keepSec || 180) / sysAudioState.segSeconds) + 1)
    for (const s of segs.slice(-sysCount)) {
      concatInputs.push('-i', s)
      concatMap.push(`[${concatMap.length}:a]`)
    }
    const n = concatMap.length
    const label = concatMap.join('')
    const listOk = await runFfmpegOk([
      '-y', '-loglevel', 'error',
      ...concatInputs,
      '-filter_complex', `concat=n=${n}:v=0:a=1[a]`,
      '-map', '[a]', '-c:a', 'pcm_s16le', wavTmp,
    ])
    if (!listOk) return false
    // 1) 优先：视频本身有音频（麦克风）→ amix
    let ok = await runFfmpegOk([
      '-y', '-loglevel', 'error',
      '-i', videoPath, '-i', wavTmp,
      '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0[a]',
      '-map', '0:v', '-map', '[a]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
      outPath,
    ])
    if (!ok) {
      // 2) 视频无音频 → 只带系统声
      ok = await runFfmpegOk([
        '-y', '-loglevel', 'error',
        '-i', videoPath, '-i', wavTmp,
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
        outPath,
      ])
    }
    try { fs.unlinkSync(wavTmp) } catch (_) {}
    return ok
  } catch (_) {
    return false
  }
}

// —— 托盘 ——
function createTray() {
  const iconData =
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWElEQVR42mNgGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjAIYAACUYAAHpK2VXAAAAAElFTkSuQmCC'
  tray = new Tray(nativeImage.createFromDataURL(iconData))
  tray.setToolTip('屏刻 ScreenRec')
  tray.on('click', showWidget)
  refreshTrayMenu()
}
function refreshTrayMenu() {
  if (!tray) return
  const on = replayEngine.running
  const template = [
    { label: '显示捕获工具', click: showWidget },
    { label: on ? `记忆回放：录制中（${fmtDur(replayEngine.bufferedSec())}）` : '记忆回放：未开启', enabled: false },
    ...(on
      ? [
          { label: `保存最近片段（${fmtDur(replayEngine.keepSec)}）`, click: () => saveReplayAuto().then((r) => notice(r.saved ? `已保存：${r.path}` : `保存回放失败：${(r && (r.message || r.reason)) || ''}`, r.saved ? 'success' : 'error')) },
          { label: '停止记忆回放', click: () => stopReplay().then(refreshTrayMenu) },
        ]
      : [{ label: '开启记忆回放', click: () => startReplayFromSettings().then(refreshTrayMenu) }]),
    { label: isAutoStartOn() ? '开机自启：已开启' : '开机自启：已关闭', click: () => setAutoStart(!isAutoStartOn()) },
    { label: '打开设置', click: ensureSettingsWindow },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; stopReplay().finally(() => app.quit()) } },
  ]
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

// —— Widget 窗口（主交互） ——
function showWidget() {
  if (!widgetWindow || widgetWindow.isDestroyed()) {
    createWidgetWindow()
    return
  }
  if (!widgetWindow.isVisible()) widgetWindow.show()
  widgetWindow.focus()
}
function createWidgetWindow() {
  const { screen: s } = require('electron')
  const wa = s.getPrimaryDisplay().workArea
  widgetWindow = new BrowserWindow({
    width: 422,
    height: 160,
    x: Math.round(wa.x + (wa.width - 422) / 2),
    y: wa.y + 12,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  widgetWindow.setAlwaysOnTop(true, 'screen-saver')
  widgetWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))
  widgetWindow.webContents.once('did-finish-load', () => pushWidgetState())
  widgetWindow.once('ready-to-show', () => widgetWindow.show())
  widgetWindow.on('close', async (e) => {
    if (quitting) return
    e.preventDefault()
    if (CLOSE_BLOCK_STATES.includes(manual.state)) {
      const { response } = await dialog.showMessageBox(widgetWindow, {
        type: 'warning',
        title: '正在录制',
        message: '录制尚未结束，确定要关闭工具吗？',
        detail: '关闭窗口不会保存录制内容。',
        buttons: ['继续录制', '确认关闭'],
        defaultId: 0,
        cancelId: 0,
      })
      if (response === 1) {
        manual.state = 'idle'
        sendCmd('force-stop')
        widgetWindow.destroy()
      }
      return
    }
    widgetWindow.hide()
  })
  widgetWindow.on('closed', () => {
    widgetWindow = null
  })
}

// —— 设置窗口 ——
function ensureSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (!settingsWindow.isVisible()) settingsWindow.show()
    settingsWindow.focus()
    return
  }
  const wa = screen.getPrimaryDisplay().workArea
  settingsWindow = new BrowserWindow({
    width: 800,
    height: 600,
    x: Math.round(wa.x + (wa.width - 800) / 2),
    y: Math.round(wa.y + (wa.height - 600) / 2),
    frame: false,
    transparent: false,
    backgroundColor: '#16181d',
    resizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  settingsWindow.loadFile(path.join(app.getAppPath(), 'settings.html'))
  settingsWindow.once('ready-to-show', () => settingsWindow.show())
  settingsWindow.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    settingsWindow.hide()
  })
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

// —— IPC：widget 与 settings ——
function registerWidgetAndSettingsIpc() {
  ipcMain.on('widget:cmd', (_e, action, payload) => {
    switch (action) {
      case 'record-toggle':
        sendCmd('toggle-record-auto')
        break
      case 'replay-toggle':
        toggleReplayEngine().then((r) => {
          if (!r.ok) notice(r.message || '回放切换失败', 'error')
        })
        break
      case 'open-settings':
        ensureSettingsWindow()
        break
      case 'toggle-pin':
        if (widgetWindow) {
          const next = !widgetWindow.isAlwaysOnTop()
          widgetWindow.setAlwaysOnTop(next, next ? 'screen-saver' : 'normal')
        }
        break
      case 'hide-widget':
        if (widgetWindow) widgetWindow.hide()
        break
    }
  })
  // 设置相关 IPC 由 settings.html 主动 invoke
  ipcMain.handle('settings:get-all', () => {
    const fs2 = require('node:fs')
    try {
      return { ok: true, settings: JSON.parse(fs2.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')) }
    } catch (_) {
      return {
        ok: true,
        settings: {
          saveDir: '',
          quality: 'original',
          fps: 30,
          micOn: true,
          keepMin: 3,
          replayQuality: '1080p',
          replayFps: 12,
          replayCacheDir: '',
          sysAudio: false,
          replaySysAudio: true,
          cursorOn: true,
          autoStart: false,
        },
      }
    }
  })
  ipcMain.handle('settings:save', (_e, settings) => {
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true })
      const fs2 = require('node:fs')
      const p = path.join(app.getPath('userData'), 'settings.json')
      const cur = (() => {
        try { return JSON.parse(fs2.readFileSync(p, 'utf8')) } catch { return {} }
      })()
      const merged = { ...cur, ...settings }
      fs2.writeFileSync(p, JSON.stringify(merged, null, 2), 'utf8')
      // 开机自启开关 → 注册 Windows 登录自启动（--hidden 后台常驻）
      if (typeof settings.autoStart === 'boolean') applyAutoStart(settings.autoStart)
      pushWidgetState()
      return { ok: true }
    } catch (e) {
      return { ok: false, message: e.message }
    }
  })
  ipcMain.handle('settings:choose-dir', async (e) => {
    const win = require('./ipc').BrowserWindowOf(e)
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '选择默认保存文件夹',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (canceled || !filePaths || !filePaths.length) return { changed: false }
    return { changed: true, dir: filePaths[0] }
  })
  ipcMain.on('settings:close', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.hide()
  })
  ipcMain.on('settings:open', () => ensureSettingsWindow())
  ipcMain.on('widget:set-pinned', (_e, v) => {
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      widgetWindow.setAlwaysOnTop(!!v, v ? 'screen-saver' : 'normal')
    }
  })
  // 麦克风多选面板展开时动态调整 widget 高度
  ipcMain.on('widget:resize', (_e, height) => {
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      const h = Math.max(160, Math.min(520, Math.round(Number(height) || 160)))
      const b = widgetWindow.getBounds()
      widgetWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: h })
    }
  })
  // 录制中切换为迷你悬浮条 / 恢复常规面板
  ipcMain.on('widget:layout', (_e, mode) => {
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      const b = widgetWindow.getBounds()
      const compact = mode === 'compact'
      const w = compact ? 252 : 422
      const h = compact ? 62 : 160
      const x = compact ? Math.round(b.x + (b.width - w) / 2) : b.x
      widgetWindow.setBounds({ x, y: b.y, width: w, height: h })
    }
  })
  ipcMain.on('widget:hide', () => {
    if (CLOSE_BLOCK_STATES.includes(manual.state)) {
      // 录制中不能销毁（需按钮停止），仅隐藏
      if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide()
      return
    }
    // 收进托盘：彻底销毁 widget 渲染进程，后台占用降到最低；
    // 托盘「显示捕获工具」/ 双击托盘 / Ctrl+Alt+G / 再次启动 都会重建唤出
    if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.destroy()
    widgetWindow = null
  })
  ipcMain.handle('replay:toggle-auto', () => toggleReplayEngine())
  // 通用回放控制（供 UI / 全局调用）
  ipcMain.handle('replay:start', (_e, p = {}) => startReplay({ keepSec: p.keepSec, fps: p.fps, targetWidth: p.targetWidth }))
  ipcMain.handle('replay:stop', () => stopReplay())
  ipcMain.handle('replay:state', () => replayState())
  ipcMain.handle('replay:save', () => saveReplayAuto())
  ipcMain.handle('replay:audio-check', () => ({ available: false }))
}

// —— 自测钩子 ——
function runSelfTest(win) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  ;(async () => {
    const out = []
    try {
      // 等待页面挂载（首启自动回放+麦克风可能较慢）
      let has = 0
      for (let i = 0; i < 40 && has < 4; i++) {
        try {
          has = await win.webContents.executeJavaScript(`document.querySelectorAll('.btn').length`)
        } catch (_) {}
        if (has < 4) await sleep(300)
      }
      out.push('btns=' + has)
      if (has < 4) {
        out.push('not-mounted')
        process.stdout.write('SELFTEST ' + out.join(' ') + '\n')
        process.exit(0)
        return
      }
      // 点「录屏」打开源选择面板
      await win.webContents.executeJavaScript(`document.querySelectorAll('.btn')[2].click()`)
      await sleep(700)
      const srcCount = await win.webContents.executeJavaScript(`document.querySelectorAll('.src-item').length`)
      out.push('src=' + srcCount)
      if (srcCount > 0) {
        // 选择第一个屏幕，尝试开始录制
        await win.webContents.executeJavaScript(`document.querySelectorAll('.src-item')[0].click()`)
        await sleep(1200)
      }
      out.push('state=' + manual.state)
      if (manual.state === 'recording') {
        // 再点录屏应结束并保存
        await win.webContents.executeJavaScript(`document.querySelectorAll('.btn')[2].click()`)
        await sleep(2000)
      }
      out.push('final=' + manual.state)
      process.stdout.write('SELFTEST ' + out.join(' ') + '\n')
    } catch (e) {
      process.stdout.write('SELFTEST_ERR ' + e.message + '\n')
    }
    process.exit(0)
  })()
}

app.whenReady().then(() => {
  if (!isPrimary) return
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media'].includes(permission))
  })
  cleanupTempDir()
  registerIpc({ setState: onManualState })
  registerWidgetAndSettingsIpc()
  registerBgIpc()
  // 全局快捷键：Ctrl+Alt+G 唤出捕获 widget（类似 Win+G，所有操作在面板内完成）
  try {
    globalShortcut.register('CommandOrControl+Alt+G', () => showWidget())
    globalShortcut.register('CommandOrControl+Alt+R', () => sendCmd('toggle-rec'))
    globalShortcut.register('CommandOrControl+Alt+P', () => sendCmd('toggle-pause'))
  } catch (_) {}

  createTray()
  startMemWatch()
  if (!AUTO_HIDDEN) {
    // 正常模式：启动 widget 窗口（主交互）
    createWidgetWindow()
  }
  // 打开软件即自动开始记忆回放（Xbox 式：持续缓冲最近 1/3/5 分钟，随时可保存）
  setTimeout(() => {
    if (manual.state === 'recording' || manual.state === 'paused' || manual.state === 'saving') return
    if (replayEngine.running) return
    startReplayFromSettings()
      .then((r) => {
        refreshTrayMenu()
        pushWidgetState()
        if (!r.ok && r.message) notice('记忆回放启动失败：' + r.message, 'warning')
      })
      .catch(() => {})
  }, 2000)

  if (process.env.SCREENREC_SELF_TEST) {
    const origShow = showWidget
    const wait = setInterval(() => {
      if (widgetWindow && !widgetWindow.isDestroyed()) {
        clearInterval(wait)
        runSelfTest(widgetWindow)
      }
    }, 200)
  }
})

app.on('window-all-closed', () => {
  // widget 收进托盘时已被销毁 → 不能因此退出；保持托盘常驻，退出只能走托盘「退出」
  if (!process.env.SCREENREC_SELF_TEST) return
  app.quit()
})

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll() } catch (_) {}
})

app.on('before-quit', () => {
  quitting = true
  stopPruneLoop()
  if (replayEngine.running) replayEngine.stop()
  cleanupTempDir()
})