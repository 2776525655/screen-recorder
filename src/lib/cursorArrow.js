/** 在画布上绘制一个系统光标箭头（白色填充 + 深色描边），锚点在 (x, y) */
export function drawCursorArrow(ctx, x, y) {
  if (!ctx) return
  ctx.save()
  ctx.translate(x, y)
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(0, 17)
  ctx.lineTo(4.5, 13)
  ctx.lineTo(7.2, 18.4)
  ctx.lineTo(10, 16.7)
  ctx.lineTo(7.3, 11.6)
  ctx.lineTo(12.6, 11.4)
  ctx.closePath()
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.lineWidth = 1.2
  ctx.strokeStyle = '#0b0b0b'
  ctx.stroke()
  ctx.restore()
}
