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

export const defaultTextStyle = (): TextStyle => ({
  fontFamily: 'sans-serif',
  fontSize: 72,
  color: '#ffffff',
  bold: true,
  italic: false,
  align: 'center',
  outlineColor: '#000000',
  outlineWidth: 4,
  background: '',
  backgroundPad: 0.4,
  shadowColor: '',
  shadowBlur: 0,
  shadowX: 0,
  shadowY: 0,
  lineHeight: 1.25,
  letterSpacing: 0,
  wrapWidth: 0
})

/** Bumped when a font finishes loading: a layer drawn with the fallback face
    must be drawn again (fonts.ts). */
let fontEpoch = 0
export function bumpFontEpoch(): void { fontEpoch++ }

export function textHash(text: string, style: TextStyle): string {
  return JSON.stringify([text, style, fontEpoch])
}

/** The lines as drawn: hard breaks kept, then (with a wrap width) greedy breaks
    at spaces; a word wider than the width keeps a line of its own. `measure`
    is the canvas's (letter spacing included). */
export function layoutText(
  text: string, style: TextStyle, measure: (s: string) => number
): { lines: string[]; widths: number[]; lineH: number; width: number; height: number } {
  const lines: string[] = []
  for (const para of text.split('\n')) {
    if (!(style.wrapWidth > 0) || measure(para) <= style.wrapWidth) { lines.push(para); continue }
    let cur = ''
    for (const word of para.split(/ +/)) {
      const next = cur ? `${cur} ${word}` : word
      if (cur && measure(next) > style.wrapWidth) { lines.push(cur); cur = word } else cur = next
    }
    lines.push(cur)
  }
  const widths = lines.map(measure)
  const lineH = style.fontSize * style.lineHeight
  return { lines, widths, lineH, width: Math.max(0, ...widths), height: lineH * lines.length }
}

/** The drawn box [x0, y0, x1, y1] in px: the block, grown to take the shadow in. */
export function textInk(block: [number, number, number, number], style: TextStyle): [number, number, number, number] {
  if (!style.shadowColor) return block
  const b = style.shadowBlur
  const [x0, y0, x1, y1] = block
  return [
    Math.min(x0, x0 + style.shadowX - b), Math.min(y0, y0 + style.shadowY - b),
    Math.max(x1, x1 + style.shadowX + b), Math.max(y1, y1 + style.shadowY + b)
  ]
}

/** Render text into a project-sized canvas (centered), cached by content. */
export function getTextLayer(
  clipId: string,
  text: string,
  style: TextStyle,
  width: number,
  height: number
): TextLayer {
  // a script may set a partial style (sanitizeProject only runs on load)
  style = { ...defaultTextStyle(), ...style }
  const hash = textHash(text, style) + `@${width}x${height}`
  const cached = cache.get(clipId)
  if (cached && cached.hash === hash) return cached

  const canvas = cached?.canvas ?? document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, width, height)

  ctx.font = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${style.fontSize}px ${quoteFamily(style.fontFamily)}`
  ctx.letterSpacing = `${style.letterSpacing}px`
  ctx.textBaseline = 'middle'
  ctx.textAlign = style.align
  const L = layoutText(text, style, (s) => ctx.measureText(s).width)
  const x = style.align === 'left' ? width * 0.1 : style.align === 'right' ? width * 0.9 : width / 2

  const pad = style.background ? style.fontSize * style.backgroundPad : Math.max(0, style.outlineWidth) / 2
  const bx =
    style.align === 'left' ? x - pad : style.align === 'right' ? x - L.width - pad : x - L.width / 2 - pad
  const by = height / 2 - L.height / 2 - pad
  const bw = L.width + pad * 2
  const bh = L.height + pad * 2
  if (style.background) {
    ctx.fillStyle = style.background
    ctx.fillRect(bx, by, bw, bh)
  }
  const [ix0, iy0, ix1, iy1] = textInk([bx, by, bx + bw, by + bh], style)
  const ink: TextLayer['ink'] = [ix0 / width, iy0 / height, ix1 / width, iy1 / height]

  // the shadow falls from the glyphs (the plate casts none), drawn once:
  // by the outline when there is one, else by the fill
  const shadow = (on: boolean) => {
    ctx.shadowColor = on && style.shadowColor ? style.shadowColor : 'transparent'
    ctx.shadowBlur = style.shadowBlur
    ctx.shadowOffsetX = style.shadowX
    ctx.shadowOffsetY = style.shadowY
  }
  L.lines.forEach((line, i) => {
    const y = height / 2 - L.height / 2 + L.lineH * (i + 0.5)
    if (style.outlineWidth > 0) {
      shadow(true)
      ctx.lineWidth = style.outlineWidth
      ctx.strokeStyle = style.outlineColor
      ctx.lineJoin = 'round'
      ctx.strokeText(line, x, y)
    }
    shadow(!(style.outlineWidth > 0))
    ctx.fillStyle = style.color
    ctx.fillText(line, x, y)
  })
  shadow(false)

  const layer: TextLayer = { canvas, hash, ink }
  cache.set(clipId, layer)
  return layer
}

/** A family name with a space or a digit must be quoted in a CSS font string;
    generic names (sans-serif) and lists («Inter, sans-serif») pass through. */
function quoteFamily(f: string): string {
  return /^[\w-]+$/.test(f) && !/^\d/.test(f) || /[,'"]/.test(f) ? f : `"${f}"`
}
