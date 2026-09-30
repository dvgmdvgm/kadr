// Node-side check of shared/proxyChoice.ts — the per-asset proxy choice
// (card H7): «Прокси: авто / всегда / никогда» on a bin item overrides the
// global «Прокси при воспроизведении» rule and its short-side threshold.
// (check-proxy.mjs is the NETWORK proxy of the API calls — a different thing.)
//
// Cost when wrong: a proxy the user cannot get rid of — «Никогда» still
// playing the 540p copy — or «Всегда» quietly ignored under the threshold.
// Run: node scripts/check-proxy-choice.mjs
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

let mod = {}
try {
  const src = readFileSync(join(root, 'shared', 'proxyChoice.ts'), 'utf8')
  const js = transformSync(src, { loader: 'ts', format: 'esm', platform: 'node' }).code
  mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
} catch (err) {
  check('shared/proxyChoice.ts loads', false, String(err).split('\n')[0])
}
const { buildsProxy, playsProxy } = mod
const run = (name, fn) => { try { fn() } catch (err) { check(name, false, String(err)) } }

const video = (o = {}) => ({ kind: 'video', width: 1920, height: 1080, ...o })
const on = { proxies: true, minSide: 720, canDecode: true }
const off = { ...on, proxies: false }
const hevc = { ...on, canDecode: false }

run('a per-asset choice overrides the global rule', () => {
  // auto follows the global rule
  check('auto: 1080p with proxies on builds', buildsProxy(video(), on) === true)
  check('auto: 1080p with proxies off does not', buildsProxy(video(), off) === false)
  check('auto: 540p under the threshold does not', buildsProxy(video({ width: 960, height: 540 }), on) === false)
  check('auto: plays the proxy with proxies on', playsProxy(video(), on) === true)
  check('auto: plays the original with proxies off', playsProxy(video(), off) === false)
  // always beats the toggle and the threshold
  const small = video({ width: 960, height: 540, proxyMode: 'always' })
  check('always: under the threshold, proxies off — builds', buildsProxy(small, off) === true)
  check('always: plays the proxy with proxies off', playsProxy(small, off) === true)
  // never beats both too
  const big = video({ width: 3840, height: 2160, proxyMode: 'never' })
  check('never: 4K with proxies on — no build', buildsProxy(big, on) === false)
  check('never: plays the original though a proxy exists', playsProxy(big, on) === false)
  check('never: an HDR source plays its original (untoned)', playsProxy({ ...big, hdr: 'hlg' }, on) === false)
})

run('what the choice cannot override', () => {
  // an undecodable source has no original to show — «never» would be black
  const h = video({ proxyMode: 'never' })
  check('never on an undecodable codec still builds', buildsProxy(h, hevc) === true)
  check('never on an undecodable codec still plays the proxy', playsProxy(h, hevc) === true)
  check('audio never gets a proxy, even «always»', buildsProxy({ kind: 'audio', width: 0, height: 0, proxyMode: 'always' }, on) === false)
  check('images never get a proxy', buildsProxy({ kind: 'image', width: 4000, height: 3000 }, on) === false)
  // HDR/undecodable keep their proxy under the global off (the old rule)
  check('auto: HDR builds with proxies off', buildsProxy(video({ hdr: 'pq' }), off) === true)
  check('auto: HDR plays its proxy with proxies off', playsProxy(video({ hdr: 'pq' }), off) === true)
  check('auto: undecodable 540p builds', buildsProxy(video({ width: 960, height: 540 }), { ...hevc, proxies: false }) === true)
  // snapshots decode originals at full quality — unless the original cannot be shown
  const sq = { sourceQuality: true }
  check('source quality: always plays the original', playsProxy(video({ proxyMode: 'always' }), { ...on, ...sq }) === false)
  check('source quality: auto plays the original', playsProxy(video(), { ...on, ...sq }) === false)
  check('source quality: undecodable keeps the proxy', playsProxy(video(), { ...hevc, ...sq }) === true)
  check('source quality: HDR keeps the proxy', playsProxy(video({ hdr: 'hlg' }), { ...on, ...sq }) === true)
})

// card J11: HEVC is decodable when the PLATFORM says so for the stream's profile —
// a static «no» sent every HEVC clip to its crf-23 540p proxy (the snapshot too)
run('which codecs the preview decodes (J11)', () => {
  const { chromiumDecodes } = mod
  const asked = []
  const yes = (mime) => { asked.push(mime); return true }
  const no = () => false
  check('h264 always', chromiumDecodes({ codec: 'h264' }, no) === true)
  check('unknown codec (old project) → assume yes', chromiumDecodes({}, no) === true)
  check('prores never', chromiumDecodes({ codec: 'prores', pixFmt: 'yuv422p10le' }, yes) === false)
  check('HEVC Main, platform yes → decodable', chromiumDecodes({ codec: 'hevc', pixFmt: 'yuv420p' }, yes) === true)
  check('…asked for the Main profile', asked.at(-1)?.includes('hvc1.1.'), asked.at(-1))
  check('HEVC Main10, platform yes → decodable', chromiumDecodes({ codec: 'hevc', pixFmt: 'yuv420p10le' }, yes) === true)
  check('…asked for Main10', asked.at(-1)?.includes('hvc1.2.'), asked.at(-1))
  check('HEVC, platform no → proxy', chromiumDecodes({ codec: 'hevc', pixFmt: 'yuv420p' }, no) === false)
  check('HEVC 4:2:2 (Rext) → proxy even when the platform says yes', chromiumDecodes({ codec: 'hevc', pixFmt: 'yuv422p10le' }, yes) === false)
  check('HEVC probed before pixFmt existed → proxy, as before', chromiumDecodes({ codec: 'hevc' }, yes) === false)
})

console.log(fails ? `\n${fails} FAILED` : '\nall PASS')
process.exit(fails ? 1 : 0)
