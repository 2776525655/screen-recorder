const { app, BrowserWindow, ipcMain, dialog, session, Tray, Menu, nativeImage, screen, globalShortcut, Notification } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const { registerIpc, cleanupTempDir } = require('./ipc')
const { ReplayEngine } = require('./engine/replay')
const { CursorSource } = require('./cursor')

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
let replayCacheDir = ''
let pruneTimer = null

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
  } else if (AUTO_HIDDEN) {
    // 后台常驻无窗口：用系统通知提示
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
  if (pruneTimer) {
    clearInterval(pruneTimer)
    pruneTimer = null
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
    } else if (d.type === 'export-done') {
      if (exportResolver) {
        const r = exportResolver
        exportResolver = null
        r({ ok: !!d.ok, size: d.size || 0, message: d.message || '' })
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

async function saveReplayAuto() {
  if (!replayEngine.running && replayEngine.bufferedSec() === 0) {
    return { saved: false, reason: 'empty', message: '还没有可保存的回放内容' }
  }
  try {
    const tmpDir = path.join(app.getPath('temp'), 'screenrec-cache')
    fs.mkdirSync(tmpDir, { recursive: true })
    const tmp = path.join(tmpDir, `replay_${Date.now()}.mp4`)
    const res = await replayEngine.saveReplay(tmp)
    if (!res.ok) {
      try { fs.unlinkSync(tmp) } catch (_) {}
      return { saved: false, reason: 'convert-error', message: res.message || '导出失败' }
    }
    const { getSaveDir } = require('./ipc')
    const dir = getSaveDir()
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, replayFileName())
    // 优先混入系统声音；无立体声混音时直接用原片
    const merged = await mergeSysAudio(tmp, target)
    if (!merged) fs.copyFileSync(tmp, target)
    try { fs.unlinkSync(tmp) } catch (_) {}
    const size = fs.statSync(target).size
    return { saved: true, path: target, size }
  } catch (err) {
    return { saved: false, reason: 'error', message: err.message }
  }
}

async function startReplay({ keepSec, fps, bitrate }) {
  if (CLOSE_BLOCK_STATES.includes(manual.state)) {
    return { ok: false, message: '正在手动录制，请先停止后再开启记忆回放' }
  }
  ensureCaptureWindow()
  const res = await replayEngine.start({ keepSec, fps, bitrate })
  sendReplayStartCfg({ keepSec, fps, bitrate })
  // 系统声音旁路（检测不到立体声混音则自动忽略）
  startSysAudio(keepSec || 180)
  refreshTrayMenu()
  pushWidgetState()
  return res
}

async function stopReplay() {
  await replayEngine.stop()
  stopSysAudio()
  if (captureWin) bgSend('stop')
  refreshCursorPolling()
  refreshTrayMenu()
  pushWidgetState()
  // 稍后回收隐藏窗口，让内存回到最低
  setTimeout(() => {
    if (!replayEngine.running) destroyCaptureWindow()
  }, 800)
  return { ok: true }
}

/** 从设置读取回放参数（默认 3 分钟 · 1080P · 12fps） */
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
    p.once('error', () => resolve(false))
    p.once('exit', (code) => {
      resolve(code === 0 && fs.existsSync(args[args.length - 1]) && fs.statSync(args[args.length - 1]).size > 0)
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
    for (const s of segs.slice(-90)) {
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
    if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide()
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
  if (!replayEngine.running && !process.env.SCREENREC_SELF_TEST) app.quit()
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