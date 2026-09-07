/**
 * 多麦克风混音（手动录屏用）
 * - 并行打开多个麦克风设备（deviceId 精确指定），失败项自动跳过
 * - 通过 WebAudio 把所有输入轨混到一条 MediaStreamDestination 流，交给录制器编码
 * - 返回句柄包含流/上下文/源节点/原始轨，stop 时需调用 closeMicMix 释放全部资源
 */

/** @param {string[]} deviceIds 设备 id 数组（'default' 表示不指定） */
export async function openMicMix(deviceIds) {
  const opened = await Promise.all(
    deviceIds.map(async (id) => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: id && id !== 'default' ? { deviceId: { exact: id } } : true,
          video: false,
        })
        const t = s.getAudioTracks()[0]
        if (!t) {
          s.getTracks().forEach((x) => x.stop())
          return null
        }
        return { track: t, stream: s }
      } catch (_) {
        return null
      }
    }),
  )
  const ok = opened.filter(Boolean)
  if (!ok.length) return null

  const Ctx = window.AudioContext || window.webkitAudioContext
  const ctx = new Ctx()
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume()
    } catch (_) {}
  }
  const dest = ctx.createMediaStreamDestination()
  const sources = ok.map((o) => {
    const src = ctx.createMediaStreamSource(new MediaStream([o.track]))
    src.connect(dest)
    return src
  })
  return {
    stream: dest.stream,
    ctx,
    sources,
    tracks: ok.map((o) => o.track),
    ownStreams: ok.map((o) => o.stream),
  }
}

export function closeMicMix(mix) {
  if (!mix) return
  try {
    mix.sources.forEach((s) => s.disconnect())
  } catch (_) {}
  try {
    mix.tracks.forEach((t) => t.stop())
  } catch (_) {}
  try {
    mix.ownStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
  } catch (_) {}
  try {
    mix.ctx.close()
  } catch (_) {}
}
