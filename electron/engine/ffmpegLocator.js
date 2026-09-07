const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

let cached = null

// 根目录可被主进程在 whenReady 时覆盖为 app.getAppPath()，避免 esbuild
// bundle 内联后 __dirname 指向源码目录而非 bundle 输出目录的坑。
let rootDirProvider = () => process.cwd()
function setRootDir(fn) {
  if (typeof fn === 'function') rootDirProvider = fn
}

/** 二进制定位候选：bin/ffmpeg.exe → 系统 PATH 中的 ffmpeg */
function findCandidates() {
  const root = rootDirProvider() || process.cwd()
  const list = []
  list.push(path.join(root, 'bin', 'ffmpeg.exe'))
  list.push('ffmpeg')
  return list
}

function tryRun(exe, args) {
  try {
    const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 20000, windowsHide: true })
    if (!r.error && r.status === 0) return r.stdout || ''
    return null
  } catch (_) {
    return null
  }
}

function parseVersion(out) {
  const m = (out || '').match(/ffmpeg version\s+([\w.]+)/i)
  return m ? m[1] : ''
}

function parseEncoders(out) {
  const set = new Set()
  for (const line of (out || '').split(/\r?\n/)) {
    for (const codec of ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264']) {
      if (line.includes(codec)) set.add(codec)
    }
  }
  return set
}

/** 实测某编码器是否真的可用（无硬件时 nvenc/qsv 会失败） */
function probeEncoder(exe, codec) {
  try {
    const r = spawnSync(
      exe,
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=5:d=0.2', '-frames:v', '2', '-c:v', codec, '-f', 'null', '-'],
      { encoding: 'utf8', timeout: 20000, windowsHide: true },
    )
    return !r.error && r.status === 0
  } catch (_) {
    return false
  }
}

const ENCODER_PRIORITY = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264']

function pickUsableEncoder(exe, compiled) {
  for (const c of ENCODER_PRIORITY) {
    if (compiled.has(c) && probeEncoder(exe, c)) return c
  }
  return null
}

/**
 * 返回 { exe, version, encoders:Set, encoder }；
 * encoder 为实测可用的编码器名（null 表示无可用编码器）。
 */
function check() {
  if (cached) return cached
  for (const exe of findCandidates()) {
    if (exe !== 'ffmpeg' && !fs.existsSync(exe)) continue
    const vout = tryRun(exe, ['-version'])
    if (vout === null) continue
    const eout = tryRun(exe, ['-hide_banner', '-encoders']) || ''
    const encoders = parseEncoders(eout)
    cached = {
      exe,
      version: parseVersion(vout),
      encoders,
      encoder: pickUsableEncoder(exe, encoders),
    }
    break
  }
  if (!cached) cached = { exe: null, version: '', encoders: new Set(), encoder: null }
  return cached
}

function encoderName(codec) {
  switch (codec) {
    case 'h264_nvenc':
      return 'NVIDIA NVENC（硬件）'
    case 'h264_qsv':
      return 'Intel QSV（硬件）'
    case 'h264_amf':
      return 'AMD AMF（硬件）'
    case 'libx264':
      return 'libx264（软件）'
    default:
      return '未找到可用编码器'
  }
}

function selectVideoArgs(codec) {
  switch (codec) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '21']
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '22']
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'balanced']
    case 'libx264':
      return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23']
    default:
      return null
  }
}

module.exports = { check, encoderName, selectVideoArgs, setRootDir, findCandidates }
