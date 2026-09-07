/**
 * 极轻量系统光标位置读取（koffi + user32.GetCursorPos）
 * 只读坐标，几乎零开销；图标由渲染层绘制箭头叠加。
 */
let koffi = null
try {
  koffi = require('koffi')
} catch (_) {
  koffi = null
}

class CursorSource {
  constructor() {
    this.ok = false
    this.error = ''
    this.timer = null
    this.cb = null
    this.lastX = null
    this.lastY = null
    try {
      if (!koffi) throw new Error('koffi 不可用')
      const user32 = koffi.load('user32')
      koffi.struct('CP_POINT', { x: 'int32', y: 'int32' })
      this.getCursorPos = user32.func('BOOL __stdcall GetCursorPos(_Out_ CP_POINT *lpPoint)')
      this.ok = true
    } catch (e) {
      this.error = String(e)
    }
  }

  start(cb, intervalMs = 50) {
    this.cb = cb || null
    if (!this.ok) return false
    this.stop()
    this.timer = setInterval(() => {
      if (!this.cb) return
      try {
        const pt = {}
        const r = this.getCursorPos(pt)
        if (!r || typeof pt.x !== 'number' || typeof pt.y !== 'number') return
        if (pt.x === this.lastX && pt.y === this.lastY) return
        this.lastX = pt.x
        this.lastY = pt.y
        this.cb(pt.x, pt.y)
      } catch (_) {
        /* ignore single tick error */
      }
    }, intervalMs)
    return true
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

module.exports = { CursorSource }
