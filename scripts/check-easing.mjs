// Node-side check of card F3: per-key easing. The engine (evalAnim) had five
// easings but no key could be given one; the diamond menu now sets them. The
// curve leaves a key with ITS easing and must still arrive at the next key;
// hold stays flat and steps there. Under «Плавное движение» (Anim.smooth) a
// key whose easing is not linear keeps it on its own segment — per-key easing
// wins; linear keys keep the spline. The export's gain curve steps the same way.
//
// Cost of getting it wrong: keys that overshoot or never arrive.
// Run: node scripts/check-easing.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const js = buildSync({
  stdin: {
    contents: `export { evalAnim } from './src/engine/anim'
      export { setKfEasing, kfEasingAt } from './src/components/animUtils'
      export { gainKeys } from './shared/gainKeys'`,
    resolveDir: root, loader: 'ts'
  },
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'error',
  alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
}).outputFiles[0].text
const { evalAnim, setKfEasing, kfEasingAt, gainKeys } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`)
  if (!ok) fails++
}
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e
const EASINGS = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold']
const two = (easing, smooth) => ({ value: 0, smooth, keyframes: [{ time: 1, value: 10, easing }, { time: 3, value: 50, easing: 'linear' }] })

// › each easing's curve passes through its endpoints and hold steps at the next key
for (const smooth of [false, true]) {
  for (const e of EASINGS) {
    const a = two(e, smooth)
    const samples = Array.from({ length: 201 }, (_, i) => evalAnim(a, 1 + (2 * i) / 200))
    const inside = samples.every((v) => v >= 10 - 1e-9 && v <= 50 + 1e-9)
    const before = evalAnim(a, 3 - 1e-6)
    const tag = `${e}${smooth ? ' (smooth)' : ''}`
    check(`${tag}: starts at its key`, near(evalAnim(a, 1), 10))
    check(`${tag}: lands on the next key`, near(evalAnim(a, 3), 50))
    check(`${tag}: never leaves [v0, v1]`, inside)
    if (e === 'hold') check(`${tag}: flat until the next key, then steps`, near(before, 10) && near(evalAnim(a, 2.5), 10))
    else check(`${tag}: arrives continuously`, near(before, 50, 1e-3), before)
  }
}
// the shapes are what they say
const mid = (e) => evalAnim(two(e, false), 1.5) // a quarter of the way
check('easeIn is slow out of the key', mid('easeIn') < mid('linear'))
check('easeOut is fast out of the key', mid('easeOut') > mid('linear'))
check('easeInOut is symmetric about the middle', near(evalAnim(two('easeInOut', false), 2), 30))

// › per-key easing wins on its segment under smooth
const three = (e1) => ({
  value: 0, smooth: true,
  keyframes: [{ time: 0, value: 0, easing: 'linear' }, { time: 1, value: 10, easing: e1 }, { time: 2, value: 40, easing: 'linear' }, { time: 3, value: 0, easing: 'linear' }]
})
const lin = three('linear')
const hold = three('hold')
const eio = three('easeInOut')
check('smooth: a hold key steps inside the spline', near(evalAnim(hold, 1.9), 10) && near(evalAnim(hold, 2), 40))
check('smooth: an easeInOut key uses its own curve', near(evalAnim(eio, 1.5), 25) && near(evalAnim(eio, 1.25), 10 + 30 * 0.125))
check('smooth: linear keys keep the spline', near(evalAnim(eio, 2.5), evalAnim(lin, 2.5)) && near(evalAnim(eio, 0.5), evalAnim(lin, 0.5)))
check('smooth: a spline segment is not the linear one', !near(evalAnim(lin, 1.5), 25))

// setKfEasing: every key at one of the times, and only those
const multi = { value: 0, keyframes: [{ time: 0, value: 0, easing: 'linear' }, { time: 1.005, value: 1, easing: 'linear' }, { time: 2, value: 2, easing: 'linear' }] }
const set = setKfEasing(multi, [0, 1], 'easeOut')
check('setKfEasing sets the keys at the given times (within KF_EPS)', set.keyframes.map((k) => k.easing).join() === 'easeOut,easeOut,linear')
check('setKfEasing leaves the input alone', multi.keyframes[0].easing === 'linear')
check('setKfEasing on a static anim is a no-op', setKfEasing({ value: 3 }, [0], 'hold').keyframes === undefined)
check('kfEasingAt reads the key at a time', kfEasingAt([{ value: 0 }, set], 1) === 'easeOut' && kfEasingAt([set], 5) === undefined)

// the export's gain curve steps where the preview does, smooth or not
for (const smooth of [false, true]) {
  const g = { value: 1, smooth, keyframes: [{ time: 0, value: 1, easing: 'hold' }, { time: 1, value: 0.2, easing: 'linear' }] }
  const k = gainKeys(g, 0, 2, (t) => evalAnim(g, t))
  const step = k.findIndex((p, i) => i > 0 && near(p.t, 1) && near(k[i - 1].t, 1))
  check(`gain curve: hold steps at the next key${smooth ? ' (smooth)' : ''}`, step > 0 && near(k[step - 1].v, 1) && near(k[step].v, 0.2) && k.every((p) => p.t >= 1 || near(p.v, 1)), k)
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
