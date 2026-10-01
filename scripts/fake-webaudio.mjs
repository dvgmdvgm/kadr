// A WebAudio stand-in for the node checks (K12): nodes only record what they
// are connected to, so a check can ask what the preview's graph is WIRED as.
// `AudioContext.failSink = true` makes setSinkId reject (a device switch that fails).
export function installFakeWebAudio() {
  const nodes = []
  class Node {
    constructor(kind) { this.kind = kind; this.out = new Set(); nodes.push(this) }
    connect(n) { this.out.add(n); return n }
    disconnect() { this.out.clear() }
  }
  const param = (value) => ({ value })
  class Ctx {
    static failSink = false
    state = 'running'
    sinkId = ''
    currentTime = 0
    destination = new Node('destination')
    audioWorklet = { addModule: () => Promise.resolve() }
    createGain() { const n = new Node('gain'); n.gain = param(1); return n }
    createAnalyser() { const n = new Node('analyser'); n.fftSize = 2048; n.getFloatTimeDomainData = (b) => b.fill(0); return n }
    createChannelSplitter() { return new Node('splitter') }
    createMediaElementSource(el) { const n = new Node('source'); n.el = el; return n }
    resume() { return Promise.resolve() }
    setSinkId(id) {
      if (Ctx.failSink) return Promise.reject(new Error('NotFoundError: the device is gone'))
      this.sinkId = id
      return Promise.resolve()
    }
  }
  globalThis.AudioContext = Ctx
  globalThis.StereoPannerNode = class extends Node { constructor() { super('pan'); this.pan = param(0) } }
  globalThis.AudioWorkletNode = class extends Node {
    constructor(c, name) { super(name); this.port = { postMessage: (m) => { this.last = m }, onmessage: null } }
  }
  /** the source node of an element */
  const sourceOf = (el) => nodes.find((n) => n.kind === 'source' && n.el === el)
  /** every node `from` reaches, in walk order */
  const reach = (from, seen = new Set()) => {
    for (const n of from.out) if (!seen.has(n)) { seen.add(n); reach(n, seen) }
    return seen
  }
  return { Ctx, nodes, sourceOf, reach }
}
