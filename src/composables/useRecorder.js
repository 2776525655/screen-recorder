import { ref, computed, watch } from 'vue'
import { Mp4Recorder, isMp4Supported } from '../lib/webcodecsRecorder'
import { desktopConstraints, bitrateFor, stopStream, defaultRecordingName, formatBytes } from '../lib/capture'
import { openMicMix, closeMicMix } from '../lib/audioMix'

export function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = String(Math.floor(s / 3600)).padStart(2, '0')
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const sec = String(s % 60).padStart(2, '0')
  return `${h}:${m}:${sec}`
}

/**
 * 渲染层编排：源 / WebCodecs 录制 / 保存 / 悬浮条命令。
 * 音频：麦克风设备可多选（audioInputs / selectedAudioIds），录制时并行打开并混音。
 */
export function useRecorder() {
  const loading = ref(false)
  const screens = ref([])
  const windows = ref([])
  const selected = ref(null)
  const phase = ref('idle') // idle / ready / recording / paused / saving
  const elapsed = ref(0)
  const elapsedText = computed(() => formatTime(elapsed.value))
  const mp4Ready = ref(false)
  const engine = computed(() => ({
    ok: mp4Ready.value,
    label: mp4Ready.value ? 'MP4 · WebCodecs H.264' : '不支持 MP4 编码',
  }))
  const micMuted = ref(false)
  const fps = ref(30)
  const quality = ref('1080p')
  const recordingInfo = ref('')
  const toasts = ref([])
  // 录制中实时文件大小（每 2 秒刷新一次）
  const recFileSize = ref(0)
  const recSizeText = computed(() => (recFileSize.value > 0 ? formatBytes(recFileSize.value) : ''))
  let sizeTimer = null

  // —— 麦克风（多选模型） ——
  const audioInputs = ref([]) // [{ deviceId, label }] 枚举到的全部麦克风
  const selectedAudioIds = ref([]) // 当前选中的设备 id 列表
  const hasAudio = computed(() => selectedAudioIds.value.length > 0)
  let storedAudioInputs = null // null=未设置过（默认全选）

  let session = null // { rec, micStream, mix }
  let timer = null

  const canStart = computed(() => phase.value === 'ready' && !!selected.value && mp4Ready.value)
  const busy = computed(() => phase.value === 'recording' || phase.value === 'paused' || phase.value === 'saving')

  function reportState() {
    window.screenRec?.notifyState({
      state: phase.value,
      elapsed: elapsed.value,
      micMuted: micMuted.value,
    })
  }
  watch(phase, reportState)

  function toast(message, type = 'info', action = null) {
    const id = Date.now() + Math.random()
    toasts.value.push({ id, message, type, action })
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id)
    }, 5200)
  }

  // —— 麦克风枚举 / 选择 ——
  async function ensureAudioPermission() {
    try {
      const p = await navigator.mediaDevices.getUserMedia({ audio: true })
      p.getTracks().forEach((t) => t.stop())
    } catch (_) {}
  }

  async function refreshAudioInputs() {
    await ensureAudioPermission()
    let list = []
    try {
      const devs = await navigator.mediaDevices.enumerateDevices()
      list = devs
        .filter((d) => d.kind === 'audioinput')
        .map((d) => ({
          deviceId: d.deviceId || 'default',
          label: (d.label && d.label.trim()) || '默认麦克风',
        }))
    } catch (_) {}
    const seen = new Set()
    audioInputs.value = list.filter((d) => {
      if (seen.has(d.deviceId)) return false
      seen.add(d.deviceId)
      return true
    })
  }

  /** 初始化选择：settings.audioInputs 为空/未设置时默认全选并落盘 */
  async function initAudioSelection() {
    await refreshAudioInputs()
    const ids = audioInputs.value.map((d) => d.deviceId)
    if (!Array.isArray(storedAudioInputs) || storedAudioInputs.length === 0) {
      if (Array.isArray(storedAudioInputs) && storedAudioInputs.length === 0) {
        selectedAudioIds.value = [] // 用户曾显式清空
        return
      }
      selectedAudioIds.value = ids
      persistAudioSelection()
    } else {
      const set = new Set(storedAudioInputs)
      selectedAudioIds.value = ids.filter((id) => set.has(id))
    }
  }

  function persistAudioSelection() {
    try {
      window.screenRec?.settingsSave({ audioInputs: selectedAudioIds.value })
    } catch (_) {}
  }

  function selectAllMic() {
    selectedAudioIds.value = audioInputs.value.map((d) => d.deviceId)
    persistAudioSelection()
  }

  function selectNoneMic() {
    selectedAudioIds.value = []
    persistAudioSelection()
  }

  function toggleAudioDevice(id) {
    const set = new Set(selectedAudioIds.value)
    if (set.has(id)) set.delete(id)
    else set.add(id)
    selectedAudioIds.value = [...set]
    persistAudioSelection()
  }

  // —— 初始化 ——
  async function boot() {
    try {
      mp4Ready.value = await isMp4Supported()
      if (!mp4Ready.value) toast('当前环境不支持 MP4(H.264) 编码，无法录制', 'error')
    } catch (e) {
      toast('编码能力检测失败：' + e.message, 'error')
    }
    try {
      const rr = await window.screenRec?.settingsGetAll()
      if (rr && rr.settings) {
        const s = rr.settings
        if (s.fps) fps.value = Number(s.fps) || 30
        quality.value = s && s.quality ? s.quality : 'original'
        if (Array.isArray(s.audioInputs)) storedAudioInputs = s.audioInputs
      }
    } catch (_) {}
    await initAudioSelection()
    // 主进程命令（全局快捷键等）；app 通知由页面统一监听渲染
    window.screenRec?.onRecorderCmd(handleCmd)
  }

  function handleCmd(action, payload) {
    switch (action) {
      case 'toggle-rec':
      case 'toggle-record-auto':
        toggleRecordAuto()
        break
      case 'toggle-pause':
        if (phase.value === 'recording') pauseRecording()
        else if (phase.value === 'paused') resumeRecording()
        break
      case 'stop':
      case 'force-stop':
        // force-stop 用于主进程放弃录制（丢弃当前会话）
        if (phase.value === 'recording' || phase.value === 'paused') stopRecording(true)
        break
      case 'toggle-mic':
        if (phase.value === 'recording' || phase.value === 'paused') {
          toggleMicMute()
        } else {
          toast('请先开始录制再切换麦克风', 'info')
        }
        break
    }
  }

  // widget 录制按钮/快捷键：录制中→停止；空闲→自动选主屏开始
  async function toggleRecordAuto() {
    if (phase.value === 'recording' || phase.value === 'paused') {
      await stopRecording()
      return
    }
    if (busy.value) return // saving 中
    if (phase.value === 'idle') {
      if (selected.value == null) {
        try {
          await loadSources()
        } catch (_) {}
        if (screens.value.length === 0) {
          toast('未发现可录制的屏幕', 'error')
          return
        }
        await selectSource(screens.value[0])
      }
    }
    if (phase.value === 'ready') await startRecording()
  }

  /** 从源选择面板点选：选中并立即开始录制该源 */
  async function pickSourceAndStart(source) {
    if (busy.value) return false
    await selectSource(source)
    if (phase.value === 'ready') await startRecording()
    return phase.value === 'recording' || phase.value === 'paused'
  }

  function toggleMicMute() {
    if (session && session.micStream) {
      micMuted.value = !micMuted.value
      session.micStream.getAudioTracks().forEach((t) => {
        t.enabled = !micMuted.value
      })
      reportState()
    }
  }

  // —— 源 ——
  async function loadSources() {
    loading.value = true
    try {
      const list = await window.screenRec.getSources()
      screens.value = list.filter((s) => s.type === 'screen')
      // 排除工具自身窗口（捕获面板/设置），避免无限循环
      windows.value = list
        .filter((s) => s.type === 'window' && !/屏刻|ScreenRec|^设置/.test(s.name || ''))
        .slice(0, 60)
      if (selected.value && !list.some((s) => s.id === selected.value.id)) {
        selected.value = null
        phase.value = 'idle'
      }
    } catch (e) {
      toast('获取录制源失败：' + (e.message || e), 'error')
    } finally {
      loading.value = false
    }
  }

  async function selectSource(source) {
    if (busy.value) return
    // widget 无预览需求：直接标记就绪，避免后台常驻一路隐藏采集流
    selected.value = source
    phase.value = 'ready'
  }

  // —— 计时 ——
  function startTimer() {
    stopTimer()
    timer = setInterval(() => {
      elapsed.value += 1
      reportState() // 悬浮条计时同步
    }, 1000)
  }
  function stopTimer() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }
  // —— 录制文件实时大小（仅手动录屏） ——
  function stopSizeTimer() {
    if (sizeTimer) {
      clearInterval(sizeTimer)
      sizeTimer = null
    }
    recFileSize.value = 0
  }
  async function pollFileSize() {
    if (!session || !session.rec) return
    const fp = session.rec.currentFilePath
    if (!fp) return
    try {
      const r = await window.screenRec.recTempStat({ filePath: fp })
      if (r && r.size) recFileSize.value = r.size
    } catch (_) {}
  }
  function startSizePoll() {
    stopSizeTimer()
    pollFileSize()
    sizeTimer = setInterval(pollFileSize, 2000)
  }

  // —— 录制控制 ——
  async function startRecording() {
    if (!canStart.value) {
      if (!selected.value) toast('请先选择录制来源', 'warning')
      else if (!mp4Ready.value) toast('编码器不可用，无法开始', 'error')
      return
    }
    // 手动录屏与记忆回放可同时进行（各自独立采集），不再互斥
    if (busy.value) return
    // 从设置读取最近画质/帧率/录鼠标
    let cursorOnVal = true
    try {
      const rr = await window.screenRec.settingsGetAll()
      if (rr && rr.settings) {
        if (rr.settings.fps) fps.value = Number(rr.settings.fps) || fps.value
        if (rr.settings.quality) quality.value = rr.settings.quality
        cursorOnVal = rr.settings.cursorOn !== false
      }
    } catch (_) {}
    // 磁盘空间检查（参考 OBS/UltraClear 的开盘空间告警）
    try {
      const dirRes = await window.screenRec.getSaveDir()
      const df = await window.screenRec.diskFree(dirRes && dirRes.dir)
      if (df && df.ok) {
        if (df.free < 0.5 * 1024 ** 3) {
          toast('磁盘剩余空间不足（<500MB），已取消录制，请先清理磁盘', 'error')
          return
        }
        if (df.free < 2 * 1024 ** 3) {
          toast('提示：磁盘剩余空间较少（' + formatBytes(df.free) + '），录制时长请留意', 'warning')
        }
      }
    } catch (_) {}
    const src = selected.value
    let vstream = null
    let micStream = null
    let mix = null
    try {
      vstream = await navigator.mediaDevices.getUserMedia(
        desktopConstraints(src.id, { fps: fps.value, quality: quality.value }),
      )
      if (selectedAudioIds.value.length) {
        try {
          mix = await openMicMix(selectedAudioIds.value)
          micStream = mix ? mix.stream : null
        } catch (_) {
          mix = null
          micStream = null
        }
        if (!micStream) toast('麦克风打开失败，本次录制将无声音', 'warning')
      }
      const rec = new Mp4Recorder()
      await rec.start({
        stream: vstream,
        micStream,
        bitrate: bitrateFor(quality.value),
        cursorOn: cursorOnVal,
        srcX: 0,
        srcY: 0,
      })
      session = { rec, micStream, mix }
      micMuted.value = false
      if (micStream) {
        micStream.getAudioTracks().forEach((t) => {
          t.enabled = true
        })
      }
      recordingInfo.value = src.type === 'window' ? src.name : src.name || '屏幕'
      elapsed.value = 0
      phase.value = 'recording'
      reportState()
      startTimer()
      startSizePoll()
    } catch (e) {
      stopStream(micStream)
      closeMicMix(mix)
      stopStream(vstream)
      session = null
      toast('开始录制失败：' + (e.message || e), 'error')
    }
  }

  function pauseRecording() {
    if (phase.value !== 'recording' || !session) return
    if (session.rec.pause()) {
      stopTimer()
      phase.value = 'paused'
      reportState()
    }
  }

  function resumeRecording() {
    if (phase.value !== 'paused' || !session) return
    if (session.rec.resume()) {
      startTimer()
      phase.value = 'recording'
      reportState()
    }
  }

  async function stopRecording(force = false) {
    if (phase.value !== 'recording' && phase.value !== 'paused') return
    const s = session
    if (!s) return
    session = null
    phase.value = 'saving'
    stopTimer()
    stopSizeTimer()
    reportState()
    try {
      if (force) {
        try { await s.rec.cancel() } catch (_) {}
        closeMicMix(s.mix)
        return
      }
      const info = await s.rec.stop()
      closeMicMix(s.mix) // rec.stop 已停 dest 轨，这里释放各源麦克风
      if (!info || !info.size) {
        toast('录制内容为空，未保存', 'warning')
        return
      }
      if (info.moovOk === false) {
        try { await window.screenRec?.recTempRemove({ filePath: info.filePath }) } catch (_) {}
        toast('录制文件索引未完整写入，本次未保存，请重试', 'error')
        return
      }
      // 诊断留存：把原始临时文件复制一份，供排查"无法播放"问题
      try {
        await window.screenRec?.recDebugRetain({ filePath: info.filePath })
      } catch (_) {}
      if (info.writeError) {
        toast('注意：录制过程中写盘异常，文件可能不完整：' + info.writeError, 'warning')
      }
      let res
      try {
        res = await window.screenRec.recTempSave({
          filePath: info.filePath,
          suggestedName: defaultRecordingName('mp4'),
        })
      } catch (e) {
        res = { saved: false, reason: 'ipc-error', message: e.message }
      }
      if (res.saved) {
        toast(
          `已保存到默认目录：${res.path}（${formatBytes(res.size)}）`,
          'success',
          { label: '打开所在文件夹', path: res.path },
        )
      } else if (res.reason === 'empty') {
        toast('录制内容为空，未保存', 'warning')
      } else {
        toast('保存失败：' + (res.message || res.reason), 'error')
      }
    } catch (e) {
      toast('停止录制出错：' + e.message, 'error')
      try {
        await s.rec.cancel()
      } catch (_) {}
      closeMicMix(s.mix)
    } finally {
      if (force) {
        phase.value = selected.value ? 'ready' : 'idle'
        reportState()
        return
      }
      elapsed.value = 0
      phase.value = selected.value ? 'ready' : 'idle'
      reportState()
    }
  }

  return {
    loading,
    screens,
    windows,
    selected,
    phase,
    elapsed,
    elapsedText,
    engine,
    mp4Ready,
    audioInputs,
    selectedAudioIds,
    hasAudio,
    micMuted,
    fps,
    quality,
    recordingInfo,
    toasts,
    recFileSize,
    recSizeText,
    canStart,
    busy,
    boot,
    loadSources,
    selectSource,
    toggleRecordAuto,
    pickSourceAndStart,
    refreshAudioInputs,
    selectAllMic,
    selectNoneMic,
    toggleAudioDevice,
    toggleMicMute,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    toast,
  }
}
