/** 桌面采集约束封装（Electron desktopCapturer → getUserMedia） */

export function isElectron() {
  return !!(window.screenRec && window.screenRec.getSources)
}

/**
 * 桌面流 constraints。quality: 'original' | '1080p' | '720p'
 */
export function desktopConstraints(sourceId, { fps = 30, quality = '1080p' } = {}) {
  const [maxWidth, maxHeight] = SIZE_MAP[quality] || SIZE_MAP['1080p']
  const mandatory = {
    chromeMediaSource: 'desktop',
    chromeMediaSourceId: sourceId,
    maxFrameRate: fps,
  }
  if (maxWidth) mandatory.maxWidth = maxWidth
  if (maxHeight) mandatory.maxHeight = maxHeight
  return { audio: false, video: { mandatory } }
}

export const SIZE_MAP = {
  original: [0, 0], // 0 = 不限（跟随屏幕当前分辨率，录全屏）
  '4k': [3840, 2160],
  '2k': [2560, 1440],
  '1080p': [1920, 1080],
  '720p': [1280, 720],
}

export function bitrateFor(quality) {
  switch (quality) {
    case '4k':
      return 24_000_000
    case '2k':
      return 12_000_000
    case 'original':
      return 20_000_000
    case '720p':
      return 5_000_000
    default:
      return 8_000_000
  }
}

export function qualityLabel(quality) {
  if (quality === 'original') return '跟随屏幕'
  return quality.toUpperCase()
}

/** 停止一个流的全部 track */
export function stopStream(stream) {
  if (!stream) return
  stream.getTracks().forEach((t) => t.stop())
}

/** 默认保存文件名 */
export function defaultRecordingName(ext = 'mp4') {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `录屏_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`
}

export function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}
