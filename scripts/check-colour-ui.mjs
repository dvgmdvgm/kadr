// J6: the colour section's controls write through history ONCE per gesture.
// `src/engine/colourEdit.ts` is the one seam the Inspector's «Цвет» section,
// the pipette, the palette actions and kadr_grade write through: a drag of a
// slider (or a run of keys, or the native colour picker) is one undo step
// however many values it wrote, a gesture that wrote nothing leaves none, and
// every discrete control (keyframe diamond, reset, mode, LUT) is one step.
//
// Cost of getting it wrong: a 200-px slider drag fills the 50-step undo stack
// with 200 entries and pushes the user's last real edit out of it, or a reset
// cannot be undone.
// The store is bundled with esbuild like check-project-settings-undo.mjs.
// Run: node scripts/check-colour-ui.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = buildSync({
  stdin: {
    contents: `export * from './src/engine/colourEdit.ts'
export { useEditor, newProject, newClipDefaults } from './src/state/store.ts'`,
    resolveDir: root, loader: 'ts'
  },
  bundle: true, format: 'esm', platform: 'neutral', write: false,
  mainFields: ['module', 'main'],
  alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
}).outputFiles[0].text
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
}
const M = await import('data:text/javascript;base64,' + Buffer.from(out).toString('base64'))
const { useEditor, newProject, newClipDefaults } = M

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const s = () => useEditor.getState()
const clip = () => s().project.tracks[0].clips.find((c) => c.id === 'c1')
const steps = () => s().past.length
const fresh = (extra = {}) => {
  const p = newProject()
  p.fps = 30
  p.tracks[0].clips.push({ ...newClipDefaults(), id: 'c1', kind: 'text', text: 'x', start: 2, duration: 4, inPoint: 0, ...extra })
  s().setProject(p)
  s().select(['c1'])
  s().setPlayhead(3) // clip-local 1
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

for (const name of ['colourGesture', 'colourKey', 'setParam', 'setKeyColour', 'toggleKf', 'resetParam', 'resetGroup',
  'resetColour', 'setBlend', 'setKeyMode', 'setLut', 'removeLut', 'COLOUR_PARAMS', 'paramValue', 'kfState', 'stripColour',
  'setWheel', 'resetWheel', 'addCurvePoint', 'moveCurvePoint', 'removeCurvePoint'])
  check(`colourEdit exports ${name}`, name in M)
if (fails) process.exit(1)

// ── every continuous control: a drag of N values is ONE step, undone in one Ctrl+Z
for (const param of M.COLOUR_PARAMS) {
  fresh({ lut: { path: '/x.cube', intensity: { value: 1 } }, key: { mode: 'chroma', colour: '#00ff00', tolerance: { value: 0.1 }, softness: { value: 0.1 }, spill: { value: 0 } } })
  const before = JSON.stringify(s().project)
  const n0 = steps()
  M.colourGesture()
  for (const v of [0.1, 0.2, 0.3, 0.35]) M.setParam('c1', param, v)
  check(`${param}: a drag of 4 values is one undo step`, steps() === n0 + 1, `${steps() - n0} steps`)
  check(`${param}: the last value is written`, Math.abs(M.paramValue(clip(), param, 1) - 0.35) < 1e-9, String(M.paramValue(clip(), param, 1)))
  s().undo()
  check(`${param}: one Ctrl+Z restores the clip`, JSON.stringify(s().project) === before)
}

// a gesture that wrote nothing leaves no step; the next write needs its own gesture to push
fresh()
M.colourGesture()
check('a gesture with no value leaves no step', steps() === 0)
M.setParam('c1', 'grade.exposure', 1)
M.setParam('c1', 'grade.contrast', 0.5)
check('writes after the gesture pushed stay in its step', steps() === 1, `${steps()} steps`)
M.colourGesture()
M.setParam('c1', 'grade.saturation', 0.2)
check('a new gesture is a new step', steps() === 2)
check('a grade set on an ungraded clip has all seven controls', Object.keys(clip().grade).length === 7 && clip().grade.tint.value === 0)

// arrow keys: presses in a row on one range are one step; another control, or an
// edit in between, starts a new one
fresh()
for (const v of [0.01, 0.02, 0.03]) { M.colourKey('grade.contrast'); M.setParam('c1', 'grade.contrast', v) }
check('three arrow presses on one range: one step', steps() === 1, `${steps()} steps`)
M.colourKey('grade.tint'); M.setParam('c1', 'grade.tint', 0.01)
check('a key on another range: a new step', steps() === 2)
s().setPlayhead(4)
M.toggleKf('c1', 'grade.tint')
M.colourKey('grade.tint'); M.setParam('c1', 'grade.tint', 0.02)
check('a key after another edit: a new step', steps() === 4, `${steps()} steps`)

// key colour: the native picker fires many inputs — one step
fresh({ key: { mode: 'chroma', colour: '#00ff00', tolerance: { value: 0.1 }, softness: { value: 0.1 }, spill: { value: 0 } } })
M.colourGesture()
for (const c of ['#00fe00', '#10f010', '#14be3c']) M.setKeyColour('c1', c)
check('key colour: a picker drag is one step', steps() === 1 && clip().key.colour === '#14be3c')

// ── the keyframe diamond: each click one step
fresh()
M.colourGesture(); M.setParam('c1', 'grade.exposure', 0.5)
const n1 = steps()
check('a static parameter reads «none»', M.kfState(clip(), 'grade.exposure', 1) === 'none')
M.toggleKf('c1', 'grade.exposure')
check('diamond on a static parameter: one step, a key at the playhead with its value',
  steps() === n1 + 1 && same(clip().grade.exposure.keyframes?.map((k) => [k.time, k.value]), [[1, 0.5]]))
check('…which reads «on»', M.kfState(clip(), 'grade.exposure', 1) === 'on')
s().setPlayhead(4.5) // clip-local 2.5
check('elsewhere it reads «animated»', M.kfState(clip(), 'grade.exposure', 2.5) === 'animated')
M.colourGesture(); M.setParam('c1', 'grade.exposure', 2)
check('a drag on an animated parameter writes a key at the playhead, one step',
  steps() === n1 + 2 && clip().grade.exposure.keyframes.length === 2 && M.paramValue(clip(), 'grade.exposure', 2.5) === 2)
M.toggleKf('c1', 'grade.exposure')
check('diamond on a key: removes it, one step', steps() === n1 + 3 && clip().grade.exposure.keyframes.length === 1)
s().setPlayhead(3)
M.toggleKf('c1', 'grade.exposure')
check('removing the last key leaves the parameter static at its value, one step',
  steps() === n1 + 4 && !clip().grade.exposure.keyframes && clip().grade.exposure.value === 0.5)
s().setPlayhead(9) // outside the clip
const n2 = steps()
M.toggleKf('c1', 'grade.exposure')
check('the diamond does nothing with the playhead outside the clip', steps() === n2 && M.kfState(clip(), 'grade.exposure', 7) === 'outside')

// ── resets and discrete choices: each one step, and a reset of nothing none
fresh()
M.colourGesture(); M.setParam('c1', 'grade.exposure', 1)
let n = steps()
M.resetParam('c1', 'grade.exposure')
check('double-click on a label: one step back to neutral', steps() === n + 1 && M.paramValue(clip(), 'grade.exposure', 1) === 0)
M.setBlend('c1', 'screen')
check('blend mode: one step', steps() === n + 2 && clip().blend === 'screen')
M.setBlend('c1', 'normal')
check('normal is the absent default', steps() === n + 3 && clip().blend === undefined)
M.setKeyMode('c1', 'chroma')
check('key on: one step, defaults like the sanitizer', steps() === n + 4 && clip().key.mode === 'chroma' &&
  clip().key.colour === '#00ff00' && clip().key.tolerance.value === 0.1 && clip().key.spill.value === 0)
M.colourGesture(); M.setParam('c1', 'key.tolerance', 0.3)
M.setKeyMode('c1', 'luma')
check('switching chroma → luma keeps the settings', steps() === n + 6 && clip().key.mode === 'luma' && clip().key.tolerance.value === 0.3)
M.setKeyMode('c1', 'off')
check('key off: one step, absent', steps() === n + 7 && clip().key === undefined)
M.setLut('c1', '/luts/look.cube')
check('a LUT: one step, full intensity', steps() === n + 8 && clip().lut.path === '/luts/look.cube' && clip().lut.intensity.value === 1)
M.colourGesture(); M.setParam('c1', 'lut.intensity', 0.6)
M.setLut('c1', '/luts/other.cube')
check('replacing the file keeps the intensity', steps() === n + 10 && clip().lut.intensity.value === 0.6)
M.removeLut('c1')
check('remove LUT: one step', steps() === n + 11 && clip().lut === undefined)
M.colourGesture(); M.setParam('c1', 'grade.tint', 0.4)
M.setBlend('c1', 'multiply')
n = steps()
M.resetGroup('c1', 'prim')
check('reset a group: one step, that group only', steps() === n + 1 && clip().grade === undefined && clip().blend === 'multiply')
M.setLut('c1', '/a.cube'); M.setKeyMode('c1', 'chroma')
n = steps()
M.resetColour('c1')
check('reset all colour: one step, nothing left', steps() === n + 1 && ['grade', 'lut', 'blend', 'key'].every((k) => clip()[k] === undefined))
M.resetColour('c1')
M.resetGroup('c1', 'key')
check('a reset with nothing to reset leaves no step', steps() === n + 1)

// ── «Вставить атрибуты» carries the colour as one more part
fresh({ grade: { ...Object.fromEntries(['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows'].map((k) => [k, { value: k === 'exposure' ? 1 : 0 }])) },
  blend: 'screen', lut: { path: '/l.cube', intensity: { value: 0.5 } },
  wheels: { lift: { x: 0, y: 0, level: 0.1 }, gamma: { x: 0, y: 0, level: 0 }, gain: { x: 0, y: 0, level: 0 } }, curves: { y: [[0.5, 0.6]] } })
s().project.tracks[0].clips.push({ ...newClipDefaults(), id: 'c2', kind: 'text', text: 'y', start: 8, duration: 2, inPoint: 0, key: { mode: 'luma', colour: '#000000', tolerance: { value: 0.1 }, softness: { value: 0.1 }, spill: { value: 0 } } })
s().setProject({ ...s().project })
s().select(['c1']); s().copySelection?.()
if (!s().clipboard?.length) useEditor.setState({ clipboard: [{ kind: 'video', clip: structuredClone(clip()) }] })
s().select(['c2'])
n = steps()
s().pasteAttributes(['colour'])
const c2 = s().project.tracks[0].clips.find((c) => c.id === 'c2')
check('paste attributes «Цвет»: grade, LUT and blend copied, the key removed, one step',
  steps() === n + 1 && c2.grade?.exposure.value === 1 && c2.blend === 'screen' && c2.lut?.intensity.value === 0.5 && c2.key === undefined &&
  c2.wheels?.lift.level === 0.1 && same(c2.curves, { y: [[0.5, 0.6]] }))

// ── J7: wheels and curves — a drag is one step, a delete or a reset one, nothing = none
fresh()
M.colourGesture()
for (const v of [[0.1, 0], [0.3, -0.2], [0.5, -0.4], [2, 0]]) M.setWheel('c1', 'gain', { x: v[0], y: v[1] })
check('a wheel drag of 4 positions is one undo step, the puck stays on the disc',
  steps() === 1 && clip().wheels.gain.x === 1 && clip().wheels.gain.y === 0 && clip().wheels.lift.level === 0, JSON.stringify(clip().wheels))
M.colourKey('wheels.lift'); M.setWheel('c1', 'lift', { level: -0.05 })
M.colourKey('wheels.lift'); M.setWheel('c1', 'lift', { level: -0.1 })
check('two arrow presses on a level: one step', steps() === 2 && clip().wheels.lift.level === -0.1)
M.resetWheel('c1', 'gain')
check('double-click on a disc: that wheel neutral, one step', steps() === 3 && clip().wheels.gain.x === 0 && clip().wheels.lift.level === -0.1)
M.resetWheel('c1', 'lift')
check('the last wheel back to neutral leaves no wheels at all', steps() === 4 && clip().wheels === undefined)
M.resetWheel('c1', 'lift')
check('resetting a neutral wheel leaves no step', steps() === 4)
s().undo(); s().undo()
check('Ctrl+Z walks the wheel resets back', clip().wheels?.gain.x === 1)

fresh()
M.colourGesture()
const i = M.addCurvePoint('c1', 'y', 0.25, 0.25)
for (const v of [[0.26, 0.22], [0.25, 0.2]]) M.moveCurvePoint('c1', 'y', i, v[0], v[1])
check('click + drag on the graph: one point, one undo step', steps() === 1 && same(clip().curves, { y: [[0.25, 0.2]] }), JSON.stringify(clip().curves))
M.colourGesture()
const j = M.addCurvePoint('c1', 'y', 0.72, 0.8)
M.colourGesture()
M.moveCurvePoint('c1', 'y', j, 0.1, 0.9)
check('a point cannot pass its neighbour (it stops a hair after it)', steps() === 3 && clip().curves.y[1][0] > 0.25 && clip().curves.y[1][0] < 0.3, JSON.stringify(clip().curves.y))
M.colourGesture()
check('a second point on the same x is refused', M.addCurvePoint('c1', 'y', 0.25, 0.5) === -1 && steps() === 3)
M.colourGesture(); M.addCurvePoint('c1', 'r', 0.5, 0.6)
check('another channel is its own list', steps() === 4 && same(clip().curves.r, [[0.5, 0.6]]))
M.removeCurvePoint('c1', 'r', 0)
check('double-click on a point deletes it, one step; an empty channel goes', steps() === 5 && !('r' in clip().curves))
n = steps()
M.resetGroup('c1', 'curves')
check('reset «Кривые»: one step, absent', steps() === n + 1 && clip().curves === undefined)
M.colourGesture(); M.setWheel('c1', 'gamma', { level: 0.2 })
M.colourGesture(); M.addCurvePoint('c1', 'b', 0.5, 0.4)
n = steps()
M.resetColour('c1')
check('reset all colour takes the wheels and curves too', steps() === n + 1 && clip().wheels === undefined && clip().curves === undefined)

// before/after draws the clip with its colour stripped — and nothing else changed
fresh({ blend: 'add', grade: clip()?.grade, wheels: clip()?.wheels, curves: { g: [[0.4, 0.5]] } })
const bare = M.stripColour(clip())
check('stripColour drops grade, LUT, blend, key, wheels and curves and nothing else',
  !['grade', 'lut', 'blend', 'key', 'wheels', 'curves'].some((k) => k in bare) && bare.id === 'c1' && bare.start === 2 && same(bare.transform, clip().transform))

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
