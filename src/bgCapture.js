/**
 * 后台记忆回放引擎（Xbox 式 · DXGI 桌面流 + WebCodecs 内存环形缓冲）
 * - 与手动录屏同底层（Chromium 桌面流），gdigrab 无关 → 不会让系统鼠标闪烁
 * - 编码后的 H.264 帧只放内存环形缓冲（最近 N 秒），不做磁盘分段
 * - 点击保存时才用 mp4-muxer 把环形缓冲合成为 MP4 文件
 * - 可选把系统鼠标箭头叠加进画面（默认开）
 */
import { Muxer, StreamTarget } from 'mp4-muxer'

const screenRec = window.screenRec
const KEY_MS = 2000
const AVC_CANDIDATES = ['avc1.42001f', 'avc1.4d0028', 'avc1.640028']

let cfg = null
let active = false
let stopping = false

let srcStream = null
let videoEl = null
let canvas = null
let c2d = null

let width = 0
let height = 0
let enc = null
let lastMeta = null
let rafId = 0
let clockStart = 0
let lastKeyUs = -Infinity

const ring = [] // { tsUs, chunk }
let metaTimer = null

// —— 麦克风音频（与画面同源进缓冲） ——
const audioRing = [] // { tsUs, chunk }
let aenc = null
let aMeta = null
let actx = null
let micStream = null
let scriptNode = null
let gainNode = null
let audioRate = 48000
let audioFrames = 0
let audioEnabled = false

// 系统光标（主进程推送坐标）
const cursor = { x: 0, y: 0, on: false }

function log(msg) {
  try {
    screenRec.bgLog(String(msg).slice(0, 400))
  } catch (_) {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function pickAvc(width, height, bitrate) {
  for (const codec of AVC_CANDIDATES) {
    try {
      const r = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate,
        avc: { format: 'avc' },
      })
      if (r.supported) return codec
    } catch (_) {}
  }
  return null
}

async function pickSource() {
  const list = await screenRec.getSources()
  if (cfg && cfg.sourceId) {
    const s = list.find((x) => x.id === cfg.sourceId)
    if (s) return s
  }
  return list.find((s) => s.type === 'screen') || list[0]
}

async function openStream(fps) {
  const src = await pickSource()
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: src.id,
        maxFrameRate: fps,
      },
    },
  })
  const vt = stream.getVideoTracks()[0]
  if (!vt) throw new Error('桌面流没有视频轨')
  return { stream, vt }
}

function ringBufferedSec() {
  if (!ring.length) return 0
  const first = ring[0].tsUs
  const last = ring[ring.length - 1].tsUs
  return Math.max(0, Math.min(cfg.keepSec, (last - first) / 1e6))
}

function pruneRing() {
  const keepUs = cfg.keepSec * 1e6
  while (ring.length > 1 && ring[ring.length - 1].tsUs - ring[0].tsUs > keepUs) ring.shift()
}

function pruneAudioRing() {
  const keepUs = cfg.keepSec * 1e6
  while (audioRing.length > 1 && audioRing[audioRing.length - 1].tsUs - audioRing[0].tsUs > keepUs) {
    audioRing.shift()
  }
}

async function supportsAac(sampleRate) {
  if (typeof AudioEncoder === 'undefined') return false
  try {
    const r = await AudioEncoder.isConfigSupported({
      codec: 'mp4a.40.2',
      sampleRate,
      numberOfChannels: 1,
      bitrate: 128000,
    })
    return !!r.supported
  } catch (_) {
    return false
  }
}

/** 启动默认麦克风采集（失败则静默降级为无声） */
async function setupMicAudio() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    const t = micStream.getAudioTracks()[0]
    if (!t) throw new Error('无音频轨')
    const Ctx = window.AudioContext || window.webkitAudioContext
    actx = new Ctx()
    if (actx.state === 'suspended') await actx.resume().catch(() => {})
    audioRate = actx.sampleRate || 48000
    if (!(await supportsAac(audioRate))) throw new Error('AAC 不可用')
    aenc = new AudioEncoder({
      output: (chunk, meta) => {
        aMeta = meta
        audioRing.push({ tsUs: chunk.timestamp, chunk })
        pruneAudioRing()
      },
      error: () => {},
    })
    aenc.configure({
      codec: 'mp4a.40.2',
      sampleRate: audioRate,
      numberOfChannels: 1,
      bitrate: 128000,
    })
    gainNode = actx.createGain()
    gainNode.gain.value = 0
    scriptNode = actx.createScriptProcessor(4096, 1, 1)
    const src = actx.createMediaStreamSource(new MediaStream([t]))
    src.connect(scriptNode)
    scriptNode.connect(gainNode)
    gainNode.connect(actx.destination)
    scriptNode.onaudioprocess = (ev) => {
      if (!active || stopping || !aenc) return
      const input = ev.inputBuffer.getChannelData(0)
      const n = input.length
      if (!n) return
      const pcm = new Float32Array(n)
      pcm.set(input)
      const ts = Math.round((audioFrames / audioRate) * 1e6)
      audioFrames += n
      const ad = new AudioData({
        format: 'f32-planar',
        sampleRate: audioRate,
        numberOfFrames: n,
        numberOfChannels: 1,
        timestamp: ts,
        data: pcm,
      })
      aenc.encode(ad)
      ad.close()
    }
    audioEnabled = true
  } catch (e) {
    log('麦克风音频不可用：' + (e && e.message))
    audioEnabled = false
    await closeAudio()
  }
}

async function closeAudio() {
  if (scriptNode) {
    try {
      scriptNode.onaudioprocess = null
      scriptNode.disconnect()
    } catch (_) {}
    scriptNode = null
  }
  if (gainNode) {
    try { gainNode.disconnect() } catch (_) {}
    gainNode = null
  }
  if (actx) {
    try { await actx.close() } catch (_) {}
    actx = null
  }
  if (aenc) {
    try { aenc.close() } catch (_) {}
    aenc = null
  }
  if (micStream) {
    try { micStream.getTracks().forEach((x) => x.stop()) } catch (_) {}
    micStream = null
  }
  audioRing.length = 0
  audioEnabled = false
}

function sendMeta() {
  screenRec.bgMeta({
    type: 'state',
    active: active && !!enc,
    bufferedSec: Math.round(ringBufferedSec()),
  })
}

function drawCursorArrow() {
  if (!cursor.on || !c2d) return
  const x = cursor.x - (cfg.sourceX || 0)
  const y = cursor.y - (cfg.sourceY || 0)
  if (x < -60 || y < -60 || x > width + 60 || y > height + 60) return
  c2d.save()
  c2d.translate(x, y)
  c2d.beginPath()
  c2d.moveTo(0, 0)
  c2d.lineTo(0, 17)
  c2d.lineTo(4.5, 13)
  c2d.lineTo(7.2, 18.4)
  c2d.lineTo(10, 16.7)
  c2d.lineTo(7.3, 11.6)
  c2d.lineTo(12.6, 11.4)
  c2d.closePath()
  c2d.fillStyle = '#ffffff'
  c2d.fill()
  c2d.lineWidth = 1.2
  c2d.strokeStyle = '#0b0b0b'
  c2d.stroke()
  c2d.restore()
}

function tick() {
  if (!active || stopping) return
  const tsUs = Math.round((performance.now() - clockStart) * 1000)
  let frame = null
  if (cfg.cursorOn && canvas) {
    c2d.clearRect(0, 0, width, height)
    c2d.drawImage(videoEl, 0, 0, width, height)
    drawCursorArrow()
    try {
      frame = new VideoFrame(canvas, { timestamp: tsUs })
    } catch (_) {}
  }
  if (!frame) {
    try {
      frame = new VideoFrame(videoEl, { timestamp: tsUs })
    } catch (_) {
      rafId = videoEl.requestVideoFrameCallback(tick)
      return
    }
  }
  const key = tsUs - lastKeyUs >= KEY_MS * 1000
  if (key) lastKeyUs = tsUs
  try {
    enc.encode(frame, { keyFrame: key })
  } catch (_) {}
  frame.close()
  rafId = videoEl.requestVideoFrameCallback(tick)
}

async function startEngine(c) {
  stopping = false
  active = true
  cfg = {
    fps: c.fps || 12,
    bitrate: c.bitrate || 6_000_000,
    keepSec: c.keepSec || 180,
    cursorOn: c.cursorOn !== false,
    sourceId: c.sourceId || '',
    sourceX: c.sourceX || 0,
    sourceY: c.sourceY || 0,
  }
  ring.length = 0
  audioRing.length = 0
  audioFrames = 0
  clockStart = 0
  lastKeyUs = -Infinity
  try {
    const opened = await openStream(cfg.fps)
    srcStream = opened.stream
    const vt = opened.vt

    videoEl = document.createElement('video')
    videoEl.muted = true
    videoEl.playsInline = true
    videoEl.srcObject = new MediaStream([vt])
    videoEl.style.cssText =
      'position:fixed;left:0;top:0;width:6px;height:6px;opacity:1;pointer-events:none;z-index:0;object-fit:contain;'
    document.body.appendChild(videoEl)
    await videoEl.play().catch(() => {})
    if (!videoEl.videoWidth || !videoEl.videoHeight) {
      await new Promise((resolve) => {
        const onMeta = () => resolve()
        videoEl.addEventListener('loadedmetadata', onMeta, { once: true })
        setTimeout(() => {
          videoEl.removeEventListener('loadedmetadata', onMeta)
          resolve()
        }, 3000)
      }).catch(() => {})
    }
    // 取真实帧尺寸
    let fw = 0
    let fh = 0
    for (let i = 0; i < 30 && !fw; i++) {
      try {
        const probe = new VideoFrame(videoEl)
        fw = probe.displayWidth || probe.codedWidth || 0
        fh = probe.displayHeight || probe.codedHeight || 0
        probe.close()
      } catch (_) {}
      if (!fw) await sleep(60)
    }
    width = fw || videoEl.videoWidth || 1920
    height = fh || videoEl.videoHeight || 1080
    if (width % 2) width -= 1
    if (height % 2) height -= 1

    if (cfg.cursorOn) {
      canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      canvas.style.cssText =
        'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;pointer-events:none;'
      document.body.appendChild(canvas)
      c2d = canvas.getContext('2d')
    }

    const avc = await pickAvc(width, height, cfg.bitrate)
    if (!avc) throw new Error('当前设备不支持 H.264 编码')
    enc = new VideoEncoder({
      output: (chunk, meta) => {
        lastMeta = meta
        ring.push({ tsUs: chunk.timestamp, chunk, meta })
        pruneRing()
      },
      error: () => {},
    })
    enc.configure({
      codec: avc,
      width,
      height,
      bitrate: cfg.bitrate,
      framerate: cfg.fps,
      avc: { format: 'avc' },
    })
    clockStart = performance.now()
    await setupMicAudio()
    metaTimer = setInterval(sendMeta, 1000)
    sendMeta()
    rafId = videoEl.requestVideoFrameCallback(tick)
    log('引擎启动 fps=' + cfg.fps + ' ' + width + 'x' + height + ' cursor=' + cfg.cursorOn + ' mic=' + audioEnabled)
  } catch (e) {
    log('启动失败：' + (e && e.message))
    active = false
    screenRec.bgMeta({ type: 'state', active: false, bufferedSec: 0, error: String((e && e.message) || e) })
    await cleanupStream()
  }
}

async function cleanupStream() {
  await closeAudio()
  if (rafId && videoEl && videoEl.cancelVideoFrameCallback) {
    try {
      videoEl.cancelVideoFrameCallback(rafId)
    } catch (_) {}
  }
  rafId = 0
  if (enc) {
    try {
      enc.close()
    } catch (_) {}
    enc = null
  }
  if (srcStream) {
    try {
      srcStream.getTracks().forEach((t) => t.stop())
    } catch (_) {}
    srcStream = null
  }
  if (videoEl) {
    try {
      videoEl.srcObject = null
      videoEl.remove()
    } catch (_) {}
    videoEl = null
  }
  if (canvas) {
    try {
      canvas.remove()
    } catch (_) {}
    canvas = null
    c2d = null
  }
  if (metaTimer) {
    clearInterval(metaTimer)
    metaTimer = null
  }
}

async function stopEngine() {
  stopping = true
  active = false
  await cleanupStream()
  ring.length = 0
  screenRec.bgMeta({ type: 'state', active: false, bufferedSec: 0 })
  log('引擎停止')
}

// —— 导出：把环形缓冲合成 MP4 文件 ——
async function doExport(filePath) {
  const done = (ok, extra = {}) => {
    screenRec.bgMeta({ type: 'export-done', ok, filePath, ...extra })
  }
  try {
    if (!ring.length) return done(false, { message: '暂无缓冲内容' })
    const mk = await screenRec.bgMkFile({ filePath })
    if (!mk || !mk.ok) return done(false, { message: '无法创建输出文件' })

    const keepUs = cfg.keepSec * 1e6
    const last = ring[ring.length - 1].tsUs
    const cut = Math.max(0, last - keepUs)
    const data = ring.filter((r) => r.tsUs >= cut)
    if (!data.length) return done(false, { message: '暂无可用帧' })

    // 取同窗口的音频（若有麦克风）
    let audioData = []
    if (audioEnabled && aenc) {
      try { await aenc.flush() } catch (_) {}
    }
    if (audioEnabled && audioRing.length) {
      const alast = audioRing[audioRing.length - 1].tsUs
      const acut = Math.max(0, alast - keepUs)
      audioData = audioRing.filter((a) => a.tsUs >= acut)
    }

    const w = width
    const h = height
    const state = { bytes: 0, p: Promise.resolve() }
    const realMuxer = new Muxer({
      target: new StreamTarget({
        onData: (d, position) => {
          const buf = d.slice()
          const off = typeof position === 'number' && position >= 0 ? position : state.bytes
          state.bytes = Math.max(state.bytes, off + buf.byteLength)
          state.p = state.p
            .then(() => screenRec.recTempAppend({ filePath, offset: off, data: buf }))
            .catch(() => {})
        },
        chunked: true,
        chunkSize: 4 * 1024 * 1024,
      }),
      video: { codec: 'avc', width: w, height: h },
      ...(audioData.length ? { audio: { codec: 'aac', numberOfChannels: 1, sampleRate: audioRate } } : {}),
      fastStart: false,
      firstTimestampBehavior: 'offset',
    })

    let firstDecoder = null
    for (const item of data) {
      if (!firstDecoder && item.meta && item.meta.decoderConfig) {
        firstDecoder = item.meta.decoderConfig
      }
      try {
        realMuxer.addVideoChunk(item.chunk, {
          decoderConfig: firstDecoder,
          ccs: item.meta ? item.meta.ccs : undefined,
        })
      } catch (_) {}
    }
    let firstAdec = null
    for (const item of audioData) {
      if (!firstAdec && aMeta && aMeta.decoderConfig) firstAdec = aMeta.decoderConfig
      try {
        realMuxer.addAudioChunk(item.chunk, { decoderConfig: firstAdec })
      } catch (_) {}
    }
    try {
      realMuxer.finalize()
    } catch (_) {}
    await state.p.catch(() => {})
    const st = await screenRec.recTempStat({ filePath }).catch(() => ({ size: 0 }))
    done(true, { size: st && st.size ? st.size : 0 })
    log('导出完成 size=' + (st && st.size))
  } catch (e) {
    log('导出失败：' + (e && e.message))
    done(false, { message: String((e && e.message) || e) })
  }
}

// —— 主进程命令 ——
screenRec.onBgCmd((d) => {
  if (!d) return
  if (d.type === 'start') startEngine(d)
  else if (d.type === 'stop') stopEngine()
  else if (d.type === 'export') doExport(d.filePath)
  else if (d.type === 'cursor') {
    cursor.on = true
    if (typeof d.x === 'number') cursor.x = d.x
    if (typeof d.y === 'number') cursor.y = d.y
  } else if (d.type === 'cursor-off') {
    cursor.on = false
  }
})
screenRec.bgReady()
