/**
 * 后台记忆回放引擎（Xbox 式 · DXGI 桌面流 + WebCodecs）
 * 磁盘分段版：画面按 2 秒关键帧边界切成独立 mp4 小段落盘（video-only），
 * 内存只保留「当前 2 秒段」+ 很小的音频环；导出时主进程 ffmpeg 无损拼接。
 * - 不再把最近 N 分钟的视频驻留内存 → 后台内存恒定，不随运行时间增长
 * - 系统鼠标箭头叠加、麦克风采集逻辑保持不变
 */
import { Muxer, StreamTarget } from 'mp4-muxer'

const screenRec = window.screenRec
const KEY_MS = 2000 // 关键帧间隔 = 段长
const AVC_CANDIDATES = ['avc1.42001f', 'avc1.4d0028', 'avc1.640028']

let cfg = null
let active = false
let stopping = false
let exporting = false

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

// —— 磁盘分段状态 ——
let segSeq = 0
let segStartUs = 0 // 当前段第一帧 tsUs
let segEndUs = 0 // 当前段已见到的最后一帧 tsUs
let curSeg = [] // { tsUs, chunk, meta }，最多 ~2s 帧
const segList = [] // 已落盘段元数据（内存轻量，供 bufferedSec 统计）
let metaTimer = null
let gcTimer = null
let writing = Promise.resolve() // 串行化写盘链

// —— 麦克风音频（内存小环，导出时写入 m4a） ——
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

function segPath(seq) {
  return (cfg.cacheDir || '') + '/seg_' + String(seq).padStart(6, '0') + '.mp4'
}

async function pickAvc(w, h, bitrate) {
  for (const codec of AVC_CANDIDATES) {
    try {
      const r = await VideoEncoder.isConfigSupported({
        codec,
        width: w,
        height: h,
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

// —— 缓冲时长（按已落盘段 + 当前段估算） ——
function bufferedSec() {
  let start = Infinity
  let end = 0
  if (segList.length) {
    start = Math.min(start, segList[0].startUs)
    end = Math.max(end, segList[segList.length - 1].endUs)
  }
  if (curSeg.length) {
    start = Math.min(start, segStartUs)
    end = Math.max(end, segEndUs)
  }
  if (!isFinite(start) || end <= start) return 0
  return Math.max(0, Math.min(cfg.keepSec, (end - start) / 1e6))
}

function sendMeta() {
  screenRec.bgMeta({
    type: 'state',
    active: active && !!enc,
    bufferedSec: Math.round(bufferedSec()),
  })
}

/** 把一段快照写入独立 mp4（随机偏移写，mp4-muxer 直接产出可独立播放的小文件） */
function writeSegment(chunks, startUs, endUs) {
  const filePath = segPath(segSeq++)
  return screenRec
    .bgMkFile({ filePath })
    .then((mk) => {
      if (!mk || !mk.ok) throw new Error('创建段文件失败')
      return new Promise((resolve, reject) => {
        try {
          const state = { bytes: 0, p: Promise.resolve() }
          const muxer = new Muxer({
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
              chunkSize: 2 * 1024 * 1024,
            }),
            video: { codec: 'avc', width, height },
            fastStart: false,
            firstTimestampBehavior: 'offset',
          })
          let firstDecoder = null
          for (const item of chunks) {
            if (!firstDecoder && item.meta && item.meta.decoderConfig) {
              firstDecoder = item.meta.decoderConfig
            }
            try {
              muxer.addVideoChunk(item.chunk, {
                decoderConfig: firstDecoder,
                ccs: item.meta ? item.meta.ccs : undefined,
              })
            } catch (_) {}
          }
          try {
            muxer.finalize()
          } catch (_) {}
          state.p.then(resolve).catch(reject)
        } catch (e) {
          reject(e)
        }
      })
    })
    .then(() => {
      segList.push({ file: filePath, startUs, endUs })
      pruneSegList()
      // 通知主进程登记这段（供导出拼接 / 清理磁盘）
      screenRec.bgMeta({ type: 'seg', file: filePath, startUs, endUs, seq: segSeq - 1 })
    })
    .catch((e) => {
      log('分段落盘失败：' + (e && e.message))
    })
}

/** 主进程只保留最近 keepSec 的段文件（本端仅删元数据；磁盘由主进程清理） */
function pruneSegList() {
  const keepUs = cfg.keepSec * 1e6
  while (segList.length > 1 && segList[segList.length - 1].endUs - segList[0].startUs > keepUs) {
    segList.shift()
  }
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

/** 关闭当前段：把已积累的帧（到最新关键帧前）写成独立 mp4 */
function closeCurrentSegment() {
  if (!curSeg.length) return Promise.resolve()
  const chunks = curSeg
  const startUs = segStartUs
  const endUs = segEndUs
  curSeg = []
  segStartUs = 0
  segEndUs = 0
  writing = writing.then(() => writeSegment(chunks, startUs, endUs))
  return writing.catch(() => {})
}

function tick() {
  if (!active || stopping) return
  if (exporting) {
    // 导出期间跳过取帧，但保持 rVFC 循环，导出结束后立即恢复
    rafId = videoEl.requestVideoFrameCallback(tick)
    return
  }
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
  try {
    enc.encode(frame, { keyFrame: tsUs - lastKeyUs >= KEY_MS * 1000 })
  } catch (_) {}
  frame.close()
  rafId = videoEl.requestVideoFrameCallback(tick)
}

function onVideoChunk(chunk, meta) {
  if (!active) return
  lastMeta = meta
  if (chunk.key && curSeg.length) {
    // 新关键帧 = 上一段结束边界 → 先落盘上一段
    closeCurrentSegment()
  }
  if (!curSeg.length) {
    segStartUs = chunk.timestamp
    segEndUs = chunk.timestamp
  }
  segEndUs = Math.max(segEndUs, chunk.timestamp)
  curSeg.push({ tsUs: chunk.timestamp, chunk, meta })
}

async function startEngine(c) {
  stopping = false
  exporting = false
  active = true
  cfg = {
    fps: c.fps || 12,
    bitrate: c.bitrate || 6_000_000,
    keepSec: c.keepSec || 180,
    cacheDir: c.cacheDir || '',
    cursorOn: c.cursorOn !== false,
    sourceId: c.sourceId || '',
    sourceX: c.sourceX || 0,
    sourceY: c.sourceY || 0,
  }
  segSeq = 0
  segList.length = 0
  curSeg.length = 0
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
      output: onVideoChunk,
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
    // 渲染页长时间工作 V8 堆会缓慢膨胀（DXGI 帧对象、canvas 等），定期 GC 稳住
    if (typeof window.gc === 'function') {
      gcTimer = setInterval(() => {
        try {
          window.gc()
        } catch (_) {}
      }, 20000)
    }
    sendMeta()
    rafId = videoEl.requestVideoFrameCallback(tick)
    log('引擎启动(磁盘分段) fps=' + cfg.fps + ' ' + width + 'x' + height + ' cache=' + cfg.cacheDir + ' mic=' + audioEnabled)
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
  if (gcTimer) {
    clearInterval(gcTimer)
    gcTimer = null
  }
  // 停止：丢弃未落盘段，磁盘清理由主进程负责
  curSeg.length = 0
  segList.length = 0
}

async function stopEngine() {
  stopping = true
  active = false
  await cleanupStream()
  screenRec.bgMeta({ type: 'state', active: false, bufferedSec: 0 })
  log('引擎停止')
}

// —— 导出：落盘最后一段 → 麦克风环写 m4a → 通知主进程 ffmpeg 拼接 ——
async function doExport(_filePath) {
  exporting = true
  const done = (ok, extra = {}) => {
    exporting = false
    screenRec.bgMeta({ type: 'export-done', ok, ...extra })
  }
  try {
    // 1) 冲刷编码器，把当前 2 秒段也完整落盘（保证最近画面在）
    if (enc) {
      try { await enc.flush() } catch (_) {}
    }
    await closeCurrentSegment()
    await writing.catch(() => {})

    // 2) 麦克风 → 音频 m4a（独立小文件，主进程随后并入）
    let audioPath = null
    let audioSize = 0
    if (audioEnabled && aenc && audioRing.length) {
      try { await aenc.flush() } catch (_) {}
      const data = audioRing.slice()
      const mk = await screenRec.recTempCreate()
      audioPath = mk && mk.filePath ? mk.filePath : null
      if (audioPath) {
        const state = { bytes: 0, p: Promise.resolve() }
        const amux = new Muxer({
          target: new StreamTarget({
            onData: (d, position) => {
              const buf = d.slice()
              const off = typeof position === 'number' && position >= 0 ? position : state.bytes
              state.bytes = Math.max(state.bytes, off + buf.byteLength)
              state.p = state.p
                .then(() => screenRec.recTempAppend({ filePath: audioPath, offset: off, data: buf }))
                .catch(() => {})
            },
            chunked: true,
            chunkSize: 2 * 1024 * 1024,
          }),
          audio: { codec: 'aac', numberOfChannels: 1, sampleRate: audioRate },
          fastStart: false,
          firstTimestampBehavior: 'offset',
        })
        for (const item of data) {
          try {
            amux.addAudioChunk(item.chunk, { decoderConfig: aMeta ? aMeta.decoderConfig : undefined })
          } catch (_) {}
        }
        try {
          amux.finalize()
        } catch (_) {}
        await state.p.catch(() => {})
        const st = await screenRec.recTempStat({ filePath: audioPath }).catch(() => ({ size: 0 }))
        audioSize = st && st.size ? st.size : 0
        if (!audioSize) {
          try { await screenRec.recTempRemove({ filePath: audioPath }) } catch (_) {}
          audioPath = null
        }
      }
    }
    done(true, { audioPath, audioSize })
    log('导出就绪（分段已齐，mic=' + (audioPath ? audioSize : 0) + '）')
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
  else if (d.type === 'gc') {
    // 主进程内存看护触发：主动回收 V8 堆（记忆录屏缓冲在磁盘，不受影响）
    if (typeof window.gc === 'function') {
      try { window.gc() } catch (_) {}
      setTimeout(() => {
        try { window.gc() } catch (_) {}
      }, 600)
    }
  }
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
