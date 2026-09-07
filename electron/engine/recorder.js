const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

/**
 * 单 ffmpeg 进程录制器（本期 MVP 一段录制）。
 * - start：spawn ffmpeg，1.5s 内未退出视为启动成功
 * - stop：向 stdin 写 'q' 优雅结束，超时强制 kill
 * - 进程在任何时刻退出都会回调构造时传入的 onExit
 */
class FfmpegRecorder {
  /**
   * @param {(info:{code:number|null,signal:string|null,userStopping:boolean,error:string})=>void} onExit
   */
  constructor({ onExit } = {}) {
    this.onExit = onExit || null
    this.proc = null
    this.userStopping = false
    this.lastError = ''
  }

  get running() {
    return !!(this.proc && this.proc.exitCode === null && this.proc.signalCode === null)
  }

  /** @returns {Promise<{ok:boolean,message?:string,code?:number}>} */
  start(exe, args) {
    return new Promise((resolve) => {
      if (this.running) {
        resolve({ ok: false, message: '已有录制进行中' })
        return
      }
      this.userStopping = false
      this.lastError = ''
      let proc
      try {
        proc = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
      } catch (e) {
        resolve({ ok: false, message: '无法启动 ffmpeg：' + e.message })
        return
      }
      this.proc = proc
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (d) => {
        this.lastError = (this.lastError + String(d)).slice(-6000)
      })

      let settled = false
      const readyTimer = setTimeout(() => {
        settled = true
        resolve({ ok: true })
      }, 1500)

      proc.once('error', (e) => {
        if (!settled) {
          settled = true
          clearTimeout(readyTimer)
          resolve({ ok: false, message: '启动失败：' + e.message })
        }
      })

      proc.on('exit', (code, signal) => {
        clearTimeout(readyTimer)
        if (!settled) {
          // 启动阶段即退出（参数错误/缺输入等）
          settled = true
          const detail = this.lastError.split('\n').filter(Boolean).slice(-3).join(' | ')
          resolve({
            ok: false,
            code,
            message: `ffmpeg 启动后立即退出(code=${code ?? signal})：${detail}`,
          })
          return
        }
        // 录制中途退出：通知调用方
        const info = {
          code,
          signal,
          userStopping: this.userStopping,
          error: this.lastError,
        }
        this.proc = null
        if (this.onExit) this.onExit(info)
      })
    })
  }

  /** 优雅停止（写 q + 超时兜底 kill）。 */
  stop() {
    return new Promise((resolve) => {
      const proc = this.proc
      if (!proc || proc.exitCode !== null) {
        resolve({ ok: true })
        return
      }
      this.userStopping = true
      const killer = setTimeout(() => {
        try {
          proc.kill()
        } catch (_) {}
        // 仍不退则强杀
        setTimeout(() => {
          try {
            proc.kill('SIGKILL')
          } catch (_) {}
          resolve({ ok: true })
        }, 1500)
      }, 4000)
      proc.once('exit', () => {
        clearTimeout(killer)
        resolve({ ok: true })
      })
      try {
        proc.stdin.write('q\n')
      } catch (_) {
        try {
          proc.kill()
        } catch (__) {}
      }
    })
  }
}

/** 纯流拷贝 remux：in → out（faststart 标准 mp4）。返回是否成功。 */
function remuxToMp4(ffmpegExe, input, output) {
  return new Promise((resolve) => {
    if (!fs.existsSync(input)) {
      resolve(false)
      return
    }
    const proc = spawn(
      ffmpegExe,
      ['-hide_banner', '-y', '-loglevel', 'error', '-i', input, '-c', 'copy', '-movflags', '+faststart', output],
      { windowsHide: true, stdio: 'ignore' },
    )
    proc.once('error', () => resolve(false))
    proc.once('exit', (code) => {
      resolve(code === 0 && fs.existsSync(output) && fs.statSync(output).size > 0)
    })
  })
}

function defaultRecordingName(ext = 'mp4') {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `录屏_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`
}

/** 确保运行缓存目录存在并返回 { dir, name } 的临时路径 */
function allocTempFile(app) {
  const dir = path.join(app.getPath('temp'), 'screenrec-cache')
  fs.mkdirSync(dir, { recursive: true })
  const name = `rec_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`
  return { dir, path: path.join(dir, name) }
}

function safeRemove(p) {
  if (!p) return
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p)
  } catch (_) {}
}

module.exports = { FfmpegRecorder, remuxToMp4, defaultRecordingName, allocTempFile, safeRemove }
