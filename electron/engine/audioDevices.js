const { spawnSync } = require('node:child_process')

/** 通过 ffmpeg dshow 枚举音频输入设备（返回设备名数组）。无 ffmpeg 时返回空。 */
function list(ffmpegExe) {
  if (!ffmpegExe) return []
  try {
    const r = spawnSync(
      ffmpegExe,
      ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
      { encoding: 'utf8', timeout: 25000, windowsHide: true },
    )
    const out = `${r.stderr || ''}\n${r.stdout || ''}`
    const names = []
    const re = /"(.+)"\s*\(audio\)/g
    let m
    while ((m = re.exec(out))) names.push(m[1])
    return names
  } catch (_) {
    return []
  }
}

module.exports = { list }
