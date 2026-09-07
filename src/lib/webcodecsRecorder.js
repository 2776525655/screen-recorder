/**
 * WebCodecs MP4 录制内核（参考会议工具的成熟做法）
 * - 视频：VideoEncoder(H.264) + requestVideoFrameCallback 逐帧采样（有帧才回调，低 CPU）
 * - 音频：AudioEncoder(AAC) + WebAudio 采集麦克风 PCM（可与系统声混音）
 * - 封装：mp4-muxer 直出 MP4，每 4MB 分片经 IPC 追加写临时文件（长录不攒内存）
 * - 暂停：挂起取帧与音频上下文，暂停段不计入时长（时钟扣减）
 * - 采集源为 Electron 桌面流（DXGI）→ 鼠标不闪、流畅
 */
import { Muxer, StreamTarget } from 'mp4-muxer'
import { cursorEnabled, getCursor } from './cursorState'
import { drawCursorArrow } from './cursorArrow'

const AVC_CANDIDATES = ['avc1.42001f', 'avc1.4d0028', 'avc1.640028']

export async function isMp4Supported() {
  if (typeof VideoEncoder === 'undefined') return false
  try {
    const r = await VideoEncoder.isConfigSupported({
      codec: 'avc1.42001f',
      width: 640,
      height: 360,
      bitrate: 1_000_000,
      avc: { format: 'avc' },
    })
    return !!r.supported
  } catch (_) {
    return false
  }
}

async function pickAvcCodec(width, height, bitrate) {
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
    } catch (_) {
      /* try next */
    }
  }
  return null
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

/**
 * @param {MediaStream} opts.stream     桌面视频流（含视频轨）
 * @param {MediaStream|null} opts.micStream  麦克风流（可空）
 * @param {number} opts.bitrate  视频码率
 */
export class Mp4Recorder {
  constructor() {
    this.act = null
  }

  get paused() {
    return !!(this.act && this.act.paused)
  }

  get currentFilePath() {
    return this.act ? this.act.tmpPath : null
  }

  async start({ stream, micStream, bitrate, cursorOn = false, srcX = 0, srcY = 0 }) {
    if (this.act) throw new Error('正在录制中')
    const vt = stream?.getVideoTracks?.()[0]
    if (!vt) throw new Error('没有可录制的画面')

    const st = vt.getSettings?.() || {}
    const screenRec = window.screenRec
    if (!screenRec) throw new Error('运行环境缺少系统接口')

    // 取帧 video：rVFC 要求视频正在合成显示，用角落 1px 而非 display:none
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.srcObject = new MediaStream([vt])
    video.style.cssText =
      'position:fixed;left:1px;top:1px;width:1px;height:1px;opacity:1;pointer-events:none;z-index:1;object-fit:contain;background:#000;'
    document.body.appendChild(video)
    await video.play().catch(() => {})
    if (!video.videoWidth || !video.videoHeight) {
      await new Promise((resolve) => {
        const onMeta = () => resolve()
        video.addEventListener('loadedmetadata', onMeta, { once: true })
        setTimeout(() => {
          video.removeEventListener('loadedmetadata', onMeta)
          resolve()
        }, 3000)
      }).catch(() => {})
    }

    // DPI 缩放下 getSettings()/videoWidth 可能给逻辑尺寸（如 1536x864），而真实帧可能是
    // 物理像素（如 1920x1080）。直接从 video 元素抓一帧读真实像素尺寸，确保 VideoEncoder
    // 配置与后续实际帧完全一致——否则会产出尺寸错乱、无法播放的 MP4。
    let fw = 0
    let fh = 0
    for (let i = 0; i < 30 && !fw; i++) {
      try {
        const probe = new VideoFrame(video)
        if (probe) {
          fw = probe.displayWidth || probe.codedWidth || 0
          fh = probe.displayHeight || probe.codedHeight || 0
          probe.close()
        }
      } catch (_) {
        /* 视频还没出帧，稍候重试 */
      }
      if (!fw) await new Promise((r) => setTimeout(r, 60))
    }
    let width = fw || video.videoWidth || Math.round(st.width || 1280)
    let height = fh || video.videoHeight || Math.round(st.height || 720)
    if (width % 2) width -= 1
    if (height % 2) height -= 1
    if (width < 2) width = 2
    if (height < 2) height = 2

    // 鼠标指针叠加画布（仅在需要录鼠标时创建）
    let overlayCanvas = null
    let overlayCtx = null
    if (cursorOn) {
      overlayCanvas = document.createElement('canvas')
      overlayCanvas.width = width
      overlayCanvas.height = height
      overlayCanvas.style.cssText =
        'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;pointer-events:none;'
      document.body.appendChild(overlayCanvas)
      overlayCtx = overlayCanvas.getContext('2d')
    }

    const avcCodec = await pickAvcCodec(width, height, bitrate)
    if (!avcCodec) throw new Error('当前设备不支持 MP4(H.264) 编码')

    // 音频能力
    let audioEnabled = false
    let audioRate = 48000
    let audioCtx = null
    let scriptNode = null
    let gainNode = null
    let sourceNode = null
    if (micStream?.getAudioTracks?.()[0]) {
      audioCtx = new AudioContext()
      if (audioCtx.state === 'suspended') await audioCtx.resume().catch(() => {})
      audioRate = audioCtx.sampleRate || 48000
      const aacOk = await supportsAac(audioRate)
      if (!aacOk) {
        audioCtx.close().catch(() => {})
        video.remove()
        throw new Error('该设备不支持 MP4 音频(AAC) 编码')
      }
      audioEnabled = true
    }

    // 临时文件（渲染层不持有完整文件，分片经 IPC 追加）
    const tmp = await screenRec.recTempCreate()
    if (!tmp?.filePath) throw new Error('无法创建临时录制文件')
    this._writeError = null // 记录首个写盘错误，stop 时返回给上层提示
    let writeTail = Promise.resolve()
    let writeTailBytes = 0
    // mp4-muxer 要求 onData 携带字节 offset，并会回头改写文件头/索引。
    // 主进程已支持按 offset 写入，这里原样透传（若未给 offset 才追加到尾部）。
    const queueAppend = (data, position) => {
      const buf = data.slice()
      const off = typeof position === 'number' && position >= 0 ? position : writeTailBytes
      writeTailBytes = Math.max(writeTailBytes, off + buf.byteLength)
      writeTail = writeTail
        .then(() => screenRec.recTempAppend({ filePath: tmp.filePath, offset: off, data: buf }))
        .then((r) => {
          if (r && !r.ok && !this._writeError) this._writeError = r.message || '写盘失败'
        })
        .catch(() => {
          if (!this._writeError) this._writeError = '写盘失败'
        })
    }

    // muxer（metadata 放尾，最小内存；数据段 chunked 直写盘）
    const muxer = new Muxer({
      target: new StreamTarget({ onData: queueAppend, chunked: true, chunkSize: 4 * 1024 * 1024 }),
      video: { codec: 'avc', width, height },
      ...(audioEnabled ? { audio: { codec: 'aac', numberOfChannels: 1, sampleRate: audioRate } } : {}),
      fastStart: false,
      firstTimestampBehavior: 'offset',
    })

    const clock = { startPerf: performance.now(), pausedAcc: 0, pauseStartedAt: 0 }
    const act = {
      video,
      muxer,
      tmpPath: tmp.filePath,
      stream, // 视频流，stop 时关 track
      micStream: micStream || null, // 麦克风流，stop 时关 track
      clock,
      paused: false,
      rafId: 0,
      lastKeyUs: -Infinity,
      durationUs: 0,
      venc: null,
      aenc: null,
      audioEnabled,
      audioCtx,
      scriptNode: null,
      sourceNode: null,
      gainNode: null,
      writeTail,
      audioFrames: 0,
      audioRate,
      width,
      height,
      overlayCanvas,
      overlayCtx,
      cursorOn,
      srcX,
      srcY,
    }
    this.act = act

    // 视频编码器
    const venc = new VideoEncoder({
      output: (chunk, meta) => {
        try {
          muxer.addVideoChunk(chunk, meta)
        } catch (_) {}
      },
      error: () => {},
    })
    venc.configure({
      codec: avcCodec,
      width,
      height,
      bitrate,
      framerate: Math.round(st.frameRate || 30),
      avc: { format: 'avc' },
    })
    act.venc = venc

    // 音频编码器
    if (audioEnabled && audioCtx) {
      const aenc = new AudioEncoder({
        output: (chunk, meta) => {
          try {
            muxer.addAudioChunk(chunk, meta)
          } catch (_) {}
        },
        error: () => {},
      })
      aenc.configure({
        codec: 'mp4a.40.2',
        sampleRate: audioRate,
        numberOfChannels: 1,
        bitrate: 128000,
      })
      gainNode = audioCtx.createGain()
      gainNode.gain.value = 0 // 采集但不外放
      scriptNode = audioCtx.createScriptProcessor(4096, 1, 1)
      sourceNode = audioCtx.createMediaStreamSource(new MediaStream([micStream.getAudioTracks()[0]]))
      sourceNode.connect(scriptNode)
      scriptNode.connect(gainNode)
      gainNode.connect(audioCtx.destination)
      scriptNode.onaudioprocess = (ev) => {
        const s = this.act
        if (!s || s.paused || !s.aenc) return
        const input = ev.inputBuffer.getChannelData(0)
        const n = input.length
        if (!n) return
        const pcm = new Float32Array(n)
        pcm.set(input)
        const ts = Math.round((s.audioFrames / s.audioRate) * 1e6)
        s.audioFrames += n
        const ad = new AudioData({
          format: 'f32-planar',
          sampleRate: s.audioRate,
          numberOfFrames: n,
          numberOfChannels: 1,
          timestamp: ts,
          data: pcm,
        })
        s.aenc.encode(ad)
        ad.close()
      }
      act.aenc = aenc
      act.scriptNode = scriptNode
      act.sourceNode = sourceNode
      act.gainNode = gainNode
    }

    // 逐帧采样
    const clockUs = () => Math.round((performance.now() - clock.startPerf - clock.pausedAcc) * 1000)
    act.clockUs = clockUs
    const tick = () => {
      const s = this.act
      if (!s) return
      if (!s.paused) {
        const us = clockUs()
        const key = us - s.lastKeyUs >= 2_000_000
        if (key) s.lastKeyUs = us
        let frame = null
        if (s.cursorOn && s.overlayCanvas && cursorEnabled()) {
          const cur = getCursor()
          s.overlayCtx.clearRect(0, 0, s.width, s.height)
          s.overlayCtx.drawImage(s.video, 0, 0, s.width, s.height)
          drawCursorArrow(s.overlayCtx, cur.x - (s.srcX || 0), cur.y - (s.srcY || 0))
          try {
            frame = new VideoFrame(s.overlayCanvas, { timestamp: us })
          } catch (_) {}
        }
        if (!frame) {
          try {
            frame = new VideoFrame(s.video, { timestamp: us })
          } catch (_) {
            s.rafId = s.video.requestVideoFrameCallback(tick)
            return
          }
        }
        try {
          s.venc.encode(frame, { keyFrame: key })
        } catch (_) {}
        frame.close()
      }
      s.rafId = s.video.requestVideoFrameCallback(tick)
    }
    act.rafId = video.requestVideoFrameCallback(tick)
  }

  pause() {
    const s = this.act
    if (!s || s.paused) return false
    try {
      s.video.pause()
      if (s.audioCtx && s.audioCtx.state === 'running') s.audioCtx.suspend()
      s.clock.pauseStartedAt = performance.now()
      s.paused = true
      return true
    } catch (_) {
      return false
    }
  }

  resume() {
    const s = this.act
    if (!s || !s.paused) return false
    try {
      s.clock.pausedAcc += performance.now() - s.clock.pauseStartedAt
      s.video.play()
      if (s.audioCtx && s.audioCtx.state === 'suspended') s.audioCtx.resume()
      s.paused = false
      return true
    } catch (_) {
      return false
    }
  }

  /**
   * 停止录制并落盘完整临时文件。
   * @returns {Promise<{filePath:string,size:number,durationSec:number}>}
   */
  async stop() {
    const s = this.act
    if (!s) return null
    this.act = null
    try {
      s.video.pause()
    } catch (_) {}
    if (s.rafId && s.video.cancelVideoFrameCallback) {
      try {
        s.video.cancelVideoFrameCallback(s.rafId)
      } catch (_) {}
    }
    if (s.scriptNode) {
      try {
        s.scriptNode.onaudioprocess = null
        s.scriptNode.disconnect()
      } catch (_) {}
    }
    if (s.sourceNode) {
      try {
        s.sourceNode.disconnect()
      } catch (_) {}
    }
    if (s.audioCtx) {
      try {
        await s.audioCtx.close()
      } catch (_) {}
    }
    s.durationUs = s.clockUs ? s.clockUs() : 0
    try {
      await s.venc.flush()
    } catch (_) {}
    if (s.aenc) {
      try {
        await s.aenc.flush()
      } catch (_) {}
    }
    try {
      s.muxer.finalize()
    } catch (_) {}
    await s.writeTail.catch(() => {})
    try {
      s.venc.close()
    } catch (_) {}
    if (s.aenc) {
      try {
        s.aenc.close()
      } catch (_) {}
    }
    try {
      s.video.remove()
    } catch (_) {}
    if (s.overlayCanvas) {
      try {
        s.overlayCanvas.remove()
      } catch (_) {}
      s.overlayCanvas = null
      s.overlayCtx = null
    }
    if (s.stream) {
      try {
        s.stream.getTracks().forEach((t) => t.stop())
      } catch (_) {}
    }
    if (s.micStream) {
      try {
        s.micStream.getTracks().forEach((t) => t.stop())
      } catch (_) {}
    }
    const st = await window.screenRec
      .recTempStat({ filePath: s.tmpPath })
      .catch(() => ({ size: 0 }))
    return {
      filePath: s.tmpPath,
      size: st && st.size ? st.size : 0,
      durationSec: Math.round(s.durationUs / 1e6),
      width: s.width,
      height: s.height,
      audio: s.audioEnabled,
      writeError: this._writeError || null,
    }
  }

  /** 丢弃：清理编码器与临时文件 */
  async cancel() {
    const s = this.act
    if (!s) return
    this.act = null
    try {
      s.video.pause()
    } catch (_) {}
    if (s.scriptNode) {
      try {
        s.scriptNode.onaudioprocess = null
        s.scriptNode.disconnect()
      } catch (_) {}
    }
    try {
      await s.audioCtx?.close()
    } catch (_) {}
    try {
      s.venc?.close()
    } catch (_) {}
    try {
      s.aenc?.close()
    } catch (_) {}
    try {
      s.muxer.finalize()
    } catch (_) {}
    await s.writeTail.catch(() => {})
    try {
      s.video.remove()
    } catch (_) {}
    if (s.overlayCanvas) {
      try {
        s.overlayCanvas.remove()
      } catch (_) {}
      s.overlayCanvas = null
      s.overlayCtx = null
    }
    if (s.stream) {
      try {
        s.stream.getTracks().forEach((t) => t.stop())
      } catch (_) {}
    }
    if (s.micStream) {
      try {
        s.micStream.getTracks().forEach((t) => t.stop())
      } catch (_) {}
    }
    await window.screenRec.recTempRemove({ filePath: s.tmpPath }).catch(() => {})
  }
}
