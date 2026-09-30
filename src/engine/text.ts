import type { TextStyle } from '@shared/types'

export interface TextLayer {
  canvas: HTMLCanvasElement
  /** changes whenever text/style changes, used as texture cache key */
  hash: string
  /** the drawn block (plate included) in uv of the canvas: [u0, v0, u1, v1] —
      the preview gizmo frames this, not the whole project-sized canvas */
  ink: [number, number, number, number]
}

const cache = new Map<string, TextLayer>()

export function textHash(text: string, style: TextStyle): string {
  return JSON.stringify([text, style])
}

/** Render text into a project-sized canvas (centered), cached by content. */
export function getTextLayer(
  clipId: string,
  text: string,
  style: TextStyle,
  width: number,
  height: number
): TextLayer {
  const hash = textHash(text, style) + `@${width}x${height}`
  const cached = cache.get(clipId)
  if (cached && cached.hash === hash) return cached

  const canvas = cached?.canvas ?? document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, width, height)

  const font = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${style.fontSize}px ${style.fontFamily}`
  ctx.font = font
  ctx.textBaseline = 'middle'
  ctx.textAlign = style.align
  const lines = text.split('\n')
  const lineH = style.fontSize * 1.25
  const totalH = lineH * lines.length
  const x = style.align === 'left' ? width * 0.1 : style.align === 'right' ? width * 0.9 : width / 2

  let maxW = 0
  for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width)
  const pad = style.background ? style.fontSize * 0.4 : Math.max(0, style.outlineWidth) / 2
  const bx =
    style.align === 'left' ? x - pad : style.align === 'right' ? x - maxW - pad : x - maxW / 2 - pad
  const by = height / 2 - totalH / 2 - pad
  if (style.background) {
    ctx.fillStyle = style.background
    ctx.fillRect(bx, by, maxW + pad * 2, totalH + pad * 2)
  }
  const ink: TextLayer['ink'] = [bx / width, by / height, (bx + maxW + pad * 2) / width, (by + totalH + pad * 2) / height]

  lines.forEach((line, i) => {
    const y = height / 2 - totalH / 2 + lineH * (i + 0.5)
    if (style.outlineWidth > 0) {
      ctx.lineWidth = style.outlineWidth
      ctx.strokeStyle = style.outlineColor
      ctx.lineJoin = 'round'
      ctx.strokeText(line, x, y)
    }
    ctx.fillStyle = style.color
    ctx.fillText(line, x, y)
  })

  const layer: TextLayer = { canvas, hash, ink }
  cache.set(clipId, layer)
  return layer
}
