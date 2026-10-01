// The agent's semantic edit tools (card I1). Each is a thin call into
// window.kadrEditor.agentEdit (src/engine/agentEdits.ts): one store action, one
// undo step, times in project seconds landing on frames. Inputs are checked
// here, before anything reaches the page. mcp-bridge.cjs registers the table;
// scripts/check-mcp-tools.mjs runs it against the real store.
const { z } = require('zod')

const easing = z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold'])
const sec = z.number().finite().min(0)
const id = z.string().min(1)
const hex = z.string().regex(/^(#[0-9a-fA-F]{3,8})?$/)

const TOOLS = [
  {
    name: 'kadr_cut',
    fn: 'cut',
    description: 'Split every clip crossing t (project s) on trackIds (default: all unlocked tracks); linked A/V twins split too. One undo step. Returns the right halves\' ids.',
    input: { t: sec, trackIds: z.array(id).min(1).optional() }
  },
  {
    name: 'kadr_move',
    fn: 'move',
    description: 'Move a clip to start (project s), optionally onto trackId (same kind); its linked twins shift by the same amount on their own tracks. One undo step.',
    input: { clipId: id, start: sec, trackId: id.optional() }
  },
  {
    name: 'kadr_trim',
    fn: 'trim',
    description: 'Trim a clip edge ("in" or "out") to t (project s), twins along. ripple:true closes/opens the difference by moving what follows (the in edge keeps its start, the head comes off the source). Clamped at the source ends. One undo step.',
    input: { clipId: id, edge: z.enum(['in', 'out']), t: sec, ripple: z.boolean().optional() }
  },
  {
    name: 'kadr_ripple_delete',
    fn: 'rippleDelete',
    description: 'Delete and close the gap. EITHER clipIds (with their twins; closes only what they leave empty) OR start+end (a range cut out of every unlocked track; markers after it follow). One undo step.',
    input: { clipIds: z.array(id).min(1).optional(), start: sec.optional(), end: sec.optional() },
    check: (a) => {
      const range = a.start !== undefined || a.end !== undefined
      if (!!a.clipIds === range) return 'pass either clipIds or start+end'
      if (range && !(a.start !== undefined && a.end !== undefined && a.end > a.start)) return 'start and end are both needed, end > start'
    }
  },
  {
    name: 'kadr_keyframe',
    fn: 'keyframe',
    description: 'Set a keyframe on a clip at t (PROJECT seconds, must be inside the clip): param x|y (px from centre), scale, rotation (deg), opacity (0..1), rotX, rotY, z, gain (0..2). Replaces a key at the same time. easing shapes the segment the key starts. One undo step.',
    input: {
      clipId: id,
      param: z.enum(['x', 'y', 'scale', 'rotation', 'opacity', 'rotX', 'rotY', 'z', 'gain']),
      t: sec,
      value: z.number().finite(),
      easing: easing.optional()
    },
    check: (a) => {
      if ((a.param === 'opacity') && (a.value < 0 || a.value > 1)) return 'opacity is 0..1'
      if (a.param === 'gain' && (a.value < 0 || a.value > 2)) return 'gain is 0..2'
    }
  },
  {
    name: 'kadr_text_add',
    fn: 'textAdd',
    description: 'Add a text clip at `at` (project s) on the top unlocked video track, default length from the settings (kadr_trim to change). style: any TextStyle fields (fontFamily, fontSize px, color #hex, bold, italic, align, outlineColor, outlineWidth, background #hex or "", backgroundPad, shadowColor, shadowBlur, shadowX, shadowY, lineHeight, letterSpacing, wrapWidth px, 0 = no wrap). One undo step.',
    input: {
      at: sec,
      text: z.string().min(1),
      style: z.object({
        fontFamily: z.string().min(1), fontSize: z.number().positive(), color: hex,
        bold: z.boolean(), italic: z.boolean(), align: z.enum(['left', 'center', 'right']),
        outlineColor: hex, outlineWidth: z.number().min(0), background: hex,
        backgroundPad: z.number().min(0), shadowColor: hex, shadowBlur: z.number().min(0),
        shadowX: z.number(), shadowY: z.number(), lineHeight: z.number().positive(),
        letterSpacing: z.number(), wrapWidth: z.number().min(0)
      }).partial().strict().optional()
    }
  },
  {
    name: 'kadr_volume',
    fn: 'volume',
    description: 'Set a clip\'s volume (gain 0..2, 1 = unchanged; twins too): EITHER value (static, drops keys) OR keys [{t (project s), value, easing?}] (replaces all gain keys). One undo step.',
    input: {
      clipId: id,
      value: z.number().min(0).max(2).optional(),
      keys: z.array(z.object({ t: sec, value: z.number().min(0).max(2), easing: easing.optional() })).min(1).optional()
    },
    check: (a) => { if ((a.value === undefined) === (a.keys === undefined)) return 'pass either value or keys' }
  },
  {
    name: 'kadr_grade',
    fn: 'grade',
    description: 'Colour of a picture clip (the Inspector\'s «Цвет»), static values; a parameter you set loses its keyframes (key them with kadr_eval + Anim keyframes). grade: any of exposure (stops, -8..8), contrast, saturation, temperature (+ warm), tint (+ magenta), highlights, shadows (-1..1; 0 = neutral). lut: {path of a .cube, intensity 0..1} or null to remove. blend: normal|screen|multiply|add|overlay|softLight|difference (does nothing inside a transition). key: {mode chroma|luma|off, colour #rrggbb, tolerance, softness, spill 0..1 (chroma only; takes the key hue off the WHOLE clip)}. Order in the shader: key → grade → LUT → blend. One undo step.',
    input: {
      clipId: id,
      grade: z.object(Object.fromEntries(['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows']
        .map((k) => [k, z.number().finite().min(k === 'exposure' ? -8 : -1).max(k === 'exposure' ? 8 : 1)]))).partial().strict().optional(),
      lut: z.object({ path: z.string().regex(/\.cube$/i), intensity: z.number().min(0).max(1).optional() }).strict().nullable().optional(),
      blend: z.enum(['normal', 'screen', 'multiply', 'add', 'overlay', 'softLight', 'difference']).optional(),
      key: z.object({
        mode: z.enum(['chroma', 'luma', 'off']), colour: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        tolerance: z.number().min(0).max(1).optional(), softness: z.number().min(0).max(1).optional(), spill: z.number().min(0).max(1).optional()
      }).strict().optional()
    },
    check: (a) => {
      if (a.grade === undefined && a.lut === undefined && a.blend === undefined && a.key === undefined) return 'pass grade, lut, blend or key'
      if (a.grade && !Object.keys(a.grade).length) return 'grade needs at least one control'
    }
  },
  {
    name: 'kadr_marker',
    fn: 'marker',
    description: 'Add a timeline marker at t (project s) with a label (default: the next number). kind is for analysis markers only (beat|section|pause from the music map, section and pause need end; scene = a picture cut) — leave it out for an anchor. One undo step.',
    input: { t: sec, label: z.string().optional(), kind: z.enum(['beat', 'section', 'pause', 'scene']).optional(), end: sec.optional() },
    check: (a) => {
      if ((a.kind === 'section' || a.kind === 'pause') && !(a.end > a.t)) return `${a.kind} needs end > t`
      if (a.end !== undefined && !(a.kind === 'section' || a.kind === 'pause')) return 'end is for section and pause markers'
    }
  },
  {
    name: 'kadr_silences',
    fn: 'silences',
    helper: true,
    ms: 30 * 60_000,
    description: 'Pauses in speech. FIND (no apply): quiet runs of clipId (twins heard too), start+end, else the in/out range, else the whole timeline; trackIds = hear only those tracks (the voice track when music plays under it). thresholdDb below the loudest point (default -35), minSilence s (0.5), pad s kept each side (0.1); transcript words are kept. Returns proposals {id, start, end} (project s) and shows them on the timeline for the user to confirm/reject. APPLY: apply "confirmed" (what the user confirmed), "all" (all but rejected) or [ids] cuts them out of every unlocked track, ripple — one undo step.',
    input: {
      clipId: id.optional(), start: sec.optional(), end: sec.optional(), trackIds: z.array(id).min(1).optional(),
      thresholdDb: z.number().min(-90).max(-1).optional(), minSilence: z.number().min(0.05).max(60).optional(), pad: z.number().min(0).max(2).optional(),
      apply: z.union([z.enum(['confirmed', 'all']), z.array(id).min(1)]).optional()
    },
    check: (a) => {
      const range = a.start !== undefined || a.end !== undefined
      if (a.apply !== undefined && Object.keys(a).length > 1) return 'apply takes no other parameters (it cuts proposals already found)'
      if (range && !(a.start !== undefined && a.end !== undefined && a.end > a.start)) return 'start and end are both needed, end > start'
      if (range && a.clipId) return 'pass either clipId or start+end'
    }
  },
  {
    name: 'kadr_propose',
    fn: 'propose',
    helper: true,
    description: 'Propose ranges for the USER to cut — retakes (a line said again: keep the better take), false starts, fluff. Read the words first (kadr_state fields:["words"]). kind = a short lowercase name ("retake", "short", …); ranges [{start, end, reason}] in project s. They appear as flags on the timeline with the reason; a new set of one kind replaces the previous set of that kind. Proposing is no edit. Nothing is cut until the user confirms: APPLY with apply "confirmed" (optionally kind) cuts only the confirmed ranges out of every unlocked track, ripple, overlaps merged — one undo step; with nothing confirmed it errors. Never cut good takes yourself. kind "short" = clips to cut OUT of a long recording as separate shorts (reason = the file name, keep it short): they are never cut; the user confirms them and exports each to its own file (Export dialog, «Export selected», any preset incl. 9:16).',
    input: {
      kind: z.string().regex(/^[a-z][a-z_]{1,23}$/).optional(),
      ranges: z.array(z.object({ start: sec, end: sec, reason: z.string().min(1).max(300) }).strict()).min(1).max(500).optional(),
      apply: z.literal('confirmed').optional()
    },
    check: (a) => {
      if (a.apply && a.kind === 'short') return 'shorts are never cut: the user exports the confirmed ones (Export dialog, «Export selected»)'
      if (a.apply) return a.ranges ? 'apply takes no ranges (it cuts what the user confirmed)' : undefined
      if (!a.kind || !a.ranges) return 'kind and ranges are both needed (or apply: "confirmed")'
      if (a.kind === 'silence') return 'kind "silence" belongs to kadr_silences'
      const bad = a.ranges.find((r) => !(r.end > r.start))
      if (bad) return `range ${bad.start}–${bad.end}: end must be > start`
    }
  },
  {
    name: 'kadr_scenes',
    fn: 'scenes',
    helper: true,
    ms: 30 * 60_000,
    description: 'Scene cuts: hard cuts in the VIDEO of clipId, start+end, else the in/out range, else the whole timeline (ffmpeg scdet; threshold = score 0..100 a change must pass, default 10 — lower finds softer cuts). They become markers of kind "scene" (replacing the scene markers of that stretch), snap targets for edits. One undo step. Returns their times (project s).',
    input: { clipId: id.optional(), start: sec.optional(), end: sec.optional(), threshold: z.number().gt(0).max(100).optional() },
    check: (a) => {
      const range = a.start !== undefined || a.end !== undefined
      if (range && !(a.start !== undefined && a.end !== undefined && a.end > a.start)) return 'start and end are both needed, end > start'
      if (range && a.clipId) return 'pass either clipId or start+end'
    }
  },
  {
    name: 'kadr_duck',
    fn: 'duck',
    helper: true,
    ms: 30 * 60_000,
    description: 'Duck music under speech: gain keyframes on musicClipIds (twins too) that fall depthDb (default -12) while someone speaks — attack s before speech (0.3), release s after (0.5); recoveries shorter than 0.5 s stay down. Speech = the loudness of speechTrackIds OR speechClipIds (default: every track the music is not on) above thresholdDb below its loudest point (-35), plus transcript words. MULTIPLIES the gain the clips already have (running it twice ducks twice; kadr_undo reverts). One undo step. Returns the speech spans (project s) and the keys per clip.',
    input: {
      musicClipIds: z.array(id).min(1), speechTrackIds: z.array(id).min(1).optional(), speechClipIds: z.array(id).min(1).optional(),
      depthDb: z.number().min(-60).max(-1).optional(), attack: z.number().min(0).max(5).optional(), release: z.number().min(0).max(5).optional(),
      thresholdDb: z.number().min(-90).max(-1).optional()
    },
    check: (a) => { if (a.speechTrackIds && a.speechClipIds) return 'pass either speechTrackIds or speechClipIds' }
  },
  {
    name: 'kadr_undo',
    fn: 'undo',
    description: 'Undo the last `steps` undo steps (each kadr_* edit tool is exactly one). Returns their labels.',
    input: { steps: z.number().int().min(1).max(50) }
  }
]

/** The page code a tool runs: one call into kadrEditor.agentEdit. */
const pageCode = (tool, args) =>
  `return window.kadrEditor.agentEdit.${tool.fn}(${JSON.stringify(args)})`

/** Validate, then run on the page. Throws on bad input without calling editorEval. */
async function runTool(tool, args, editorEval) {
  const parsed = z.object(tool.input).strict().safeParse(args ?? {})
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '))
  const bad = tool.check && tool.check(parsed.data)
  if (bad) throw new Error(bad)
  return editorEval(pageCode(tool, parsed.data), tool.ms)
}

function registerEditTools(server, editorEval, asText, asError) {
  for (const tool of TOOLS) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args) => {
      try { return asText(await runTool(tool, args, editorEval)) } catch (e) { return asError(e) }
    })
  }
}

module.exports = { TOOLS, pageCode, runTool, registerEditTools }
