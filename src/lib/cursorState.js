/**
 * 系统光标最新坐标（由主进程高频推送），供手动录屏与后台引擎叠加用
 */
const state = { x: 0, y: 0, ts: 0 }

export function setCursor(p) {
  if (!p) return
  if (typeof p.x === 'number') state.x = p.x
  if (typeof p.y === 'number') state.y = p.y
  state.ts = Date.now()
}

/** 光标是否“活着”（最近 2 秒内有过更新） */
export function cursorEnabled() {
  return !!state.ts && Date.now() - state.ts < 2000
}

export function getCursor() {
  return state
}
