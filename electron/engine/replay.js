/**
 * 记忆回放引擎控制器（Xbox 式）
 * - 采集工作由隐藏采集窗口（Chromium DXGI 桌面流）完成，编码帧存入内存环形缓冲
 * - 本模块负责：启停状态、缓冲时长、与采集窗口 IPC 联动、导出时合成 MP4
 * - 不使用 gdigrab / 磁盘分段，因此不会造成鼠标闪烁与磁盘抖动
 */
const path = require('node:path')
const fs = require('node:fs')

class ReplayEngine {
  constructor() {
    this._active = false
    this._buffered = 0
    this.keepSec = 180
    this.fps = 12
    this._error = ''
    this._hooks = null
    this._pendingExport = null
  }

  get running() {
    return this._active
  }

  get audioOn() {
    return false // 回放为无声缓冲
  }

  setHooks(hooks) {
    this._hooks = hooks
  }

  start(cfg) {
    this.keepSec = cfg.keepSec || 180
    this.fps = cfg.fps || 12
    this._active = true
    this._buffered = 0
    this._error = ''
    if (this._hooks && this._hooks.onStart) this._hooks.onStart(cfg)
    return { ok: true }
  }

  async stop() {
    this._active = false
    this._buffered = 0
    if (this._hooks && this._hooks.onStop) await this._hooks.onStop()
    return { ok: true }
  }

  setMeta(active, buffered, err) {
    if (typeof active === 'boolean') this._active = active
    if (typeof buffered === 'number') this._buffered = buffered
    if (typeof err === 'string') this._error = err
  }

  bufferedSec() {
    return this._buffered
  }

  prune() {
    /* 环形缓冲在采集窗口内完成，无需主进程裁剪 */
  }

  clearCache() {
    /* 无磁盘缓存 */
  }

  /**
   * 导出最近 keepSec 秒为 MP4 文件（渲染层内存环 → mp4-muxer 直写）。
   * @returns {Promise<{ok:boolean, size?:number, message?:string}>}
   */
  saveReplay(outPath) {
    if (!this._hooks || !this._hooks.onExport) {
      return Promise.resolve({ ok: false, message: '引擎未就绪' })
    }
    return this._hooks.onExport(outPath)
  }

  /** 导出完成回调（由主进程收到 bg:export-done 时调用） */
  resolveExport(result) {
    if (this._pendingExport) {
      const r = this._pendingExport
      this._pendingExport = null
      r.resolve(result)
    }
  }

  setPendingExport(promise) {
    this._pendingExport = promise
  }
}

module.exports = { ReplayEngine }
