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
    name: 'kadr_marker',
    fn: 'marker',
    description: 'Add a timeline marker at t (project s) with a label (default: the next number). kind is for music-map markers only (beat|section|pause; section and pause need end) — leave it out for an anchor. One undo step.',
    input: { t: sec, label: z.string().optional(), kind: z.enum(['beat', 'section', 'pause']).optional(), end: sec.optional() },
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
