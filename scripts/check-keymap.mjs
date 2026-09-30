// Node-side check of the action registry's key logic (shared/keymap.ts). No app.
//
// The bug this guards: the editor's hotkeys were one if/else on `e.code` that
// ignored modifiers, so Ctrl+D and Shift+D deleted clips, Alt+S split, Ctrl+U
// linked, and Cmd+S (no Ctrl) split. Costs: clips deleted by a chord meant for
// something else; a rebinding nobody can make; a keymap file that silently
// forgets the user's keys.
// Run: node scripts/check-keymap.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

let mod = {}
try {
  const out = await build({
    entryPoints: [join(root, 'shared/keymap.ts')],
    bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent'
  })
  mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
} catch (err) {
  check('shared/keymap.ts loads', false, String(err).split('\n')[0])
}
const { ACTIONS, actionFor, sanitizeKeymap, keymapDiff, keysOf, findConflicts, ownsKeys } = mod

const ev = (code, mods = {}, key = '') => ({
  code, key, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta
})
const hit = (e, diff = {}) => actionFor(e, diff)?.id ?? null

if (ACTIONS) {
  // › a binding fires only on its exact modifiers
  check('D deletes', hit(ev('KeyD')) === 'edit.delete')
  check('Delete and Backspace delete', hit(ev('Delete')) === 'edit.delete' && hit(ev('Backspace')) === 'edit.delete')
  for (const [name, e] of [
    ['Ctrl+D', ev('KeyD', { ctrl: true })], ['Shift+D', ev('KeyD', { shift: true })],
    ['Alt+D', ev('KeyD', { alt: true })], ['Cmd+D', ev('KeyD', { meta: true })]
  ]) check(`${name} does nothing`, hit(e) === null, String(hit(e)))
  check('S splits', hit(ev('KeyS')) === 'edit.split')
  check('Alt+S does nothing', hit(ev('KeyS', { alt: true })) === null)
  check('Cmd+S does not split', hit(ev('KeyS', { meta: true })) === null)
  check('Ctrl+S saves, Ctrl+Shift+S saves as',
    hit(ev('KeyS', { ctrl: true })) === 'file.save' && hit(ev('KeyS', { ctrl: true, shift: true })) === 'file.saveAs')
  check('U links', hit(ev('KeyU')) === 'edit.link')
  check('Ctrl+U does nothing', hit(ev('KeyU', { ctrl: true })) === null)
  check('Ctrl+Z undoes; Ctrl+Shift+Z and Ctrl+Y redo',
    hit(ev('KeyZ', { ctrl: true })) === 'edit.undo' && hit(ev('KeyZ', { ctrl: true, shift: true })) === 'edit.redo' &&
    hit(ev('KeyY', { ctrl: true })) === 'edit.redo')
  check('Z alone does nothing', hit(ev('KeyZ')) === null)
  check('Ctrl+C copies, Ctrl+V pastes, C and V alone do nothing',
    hit(ev('KeyC', { ctrl: true })) === 'edit.copy' && hit(ev('KeyV', { ctrl: true })) === 'edit.paste' &&
    hit(ev('KeyC')) === null && hit(ev('KeyV')) === null)
  check('M places a marker, Ctrl+M does not', hit(ev('KeyM')) === 'marker.add' && hit(ev('KeyM', { ctrl: true })) === null)
  check('arrows step a frame, Shift+arrows a second',
    hit(ev('ArrowLeft')) === 'playhead.prevFrame' && hit(ev('ArrowRight')) === 'playhead.nextFrame' &&
    hit(ev('ArrowLeft', { shift: true })) === 'playhead.back1s' && hit(ev('ArrowRight', { shift: true })) === 'playhead.fwd1s')
  check('Space plays, Home goes to the start, Esc cancels',
    hit(ev('Space')) === 'transport.play' && hit(ev('Home')) === 'playhead.start' && hit(ev('Escape')) === 'edit.escape')

  // › letters are matched by physical code, in the ru and en layouts
  check('KeyD deletes whether it types d or в', hit(ev('KeyD', {}, 'd')) === 'edit.delete' && hit(ev('KeyD', {}, 'в')) === 'edit.delete')
  check('a ы typed on KeyS splits; an s typed elsewhere does not',
    hit(ev('KeyS', {}, 'ы')) === 'edit.split' && hit(ev('Semicolon', {}, 's')) === null)

  // › a conflict in one context is reported
  check('the defaults have no conflicts', findConflicts({}).length === 0, JSON.stringify(findConflicts({})))
  const clash = { 'marker.add': [{ code: 'KeyD' }] }
  const c = findConflicts(clash)
  check('a key bound to two actions in one context is reported',
    c.length === 1 && c[0].context === 'global' && c[0].ids.includes('marker.add') && c[0].ids.includes('edit.delete'),
    JSON.stringify(c))
  check('the same key with other modifiers is not a conflict',
    findConflicts({ 'marker.add': [{ code: 'KeyD', ctrl: true }] }).length === 0)

  // › the diff file round-trips
  const map = Object.fromEntries(ACTIONS.map((a) => [a.id, keysOf(a.id, {})]))
  check('an untouched keymap is an empty diff', JSON.stringify(keymapDiff(map)) === '{}')
  map['edit.delete'] = [{ code: 'Delete' }]
  map['marker.add'] = [{ code: 'KeyM', shift: true }]
  map['edit.link'] = []
  const diff = keymapDiff(map)
  check('only changed actions are written', Object.keys(diff).sort().join() === 'edit.delete,edit.link,marker.add', JSON.stringify(diff))
  const back = sanitizeKeymap(JSON.parse(JSON.stringify(diff)))
  check('the diff read back gives the same keymap',
    ACTIONS.every((a) => JSON.stringify(keysOf(a.id, back)) === JSON.stringify(map[a.id])))
  check('a rebound key fires, the old one no longer does',
    hit(ev('KeyM', { shift: true }), back) === 'marker.add' && hit(ev('KeyM'), back) === null && hit(ev('KeyD'), back) === null)
  check('an unbound action has no key', hit(ev('KeyU'), back) === null)
  const junk = sanitizeKeymap({ 'no.such': [{ code: 'KeyQ' }], 'edit.split': [{ code: 5 }, { code: 'KeyX', ctrl: 'yes' }, { code: 'KeyW', alt: true }], 'edit.copy': 'x' })
  check('a broken file keeps what it can: unknown ids and bad chords dropped',
    JSON.stringify(junk) === '{"edit.split":[{"code":"KeyW","alt":true}]}', JSON.stringify(junk))
  check('a non-object file is an empty keymap', JSON.stringify(sanitizeKeymap(null)) === '{}' && JSON.stringify(sanitizeKeymap([1])) === '{}')

  // palette-only actions are registered, with no key
  const bare = ACTIONS.filter((a) => a.defaultKeys.length === 0).map((a) => a.id)
  check('palette-only actions exist without a key',
    ['file.export', 'tools.transcribe', 'tools.beats', 'tools.sounds', 'preview.snapshot', 'preview.popout'].every((id) => bare.includes(id)),
    bare.join(','))
  check('action ids are unique', new Set(ACTIONS.map((a) => a.id)).size === ACTIONS.length)

  // keys typed where something else owns the keyboard never reach an action
  const el = (tag, { editable = false, inXterm = false } = {}) => ({
    tagName: tag, isContentEditable: editable, closest: (sel) => (sel === '.xterm' && inXterm ? {} : null)
  })
  check('the Claude terminal, inputs and contenteditable own their keys',
    ownsKeys(el('TEXTAREA', { inXterm: true })) && ownsKeys(el('DIV', { inXterm: true })) &&
    ownsKeys(el('INPUT')) && ownsKeys(el('SELECT')) && ownsKeys(el('TEXTAREA')) && ownsKeys(el('DIV', { editable: true })))
  check('a button or the page body does not', !ownsKeys(el('BUTTON')) && !ownsKeys(el('BODY')) && !ownsKeys(null))
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
