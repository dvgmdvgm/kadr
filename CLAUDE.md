# Kadr — GPU-accelerated multi-track video editor

Electron + React + TypeScript. The preview is composited on the GPU
(WebGL2); export is WYSIWYG: the same compositor renders offline frames
into WebCodecs H.264, mp4-muxer writes a temp MP4, then the system ffmpeg
mixes audio and muxes/transcodes per preset.

## Commands
- `npm run dev` — launch in dev mode (Electron needs a display)
- `npm run build` — production build into `out/`
- `npm run typecheck` — both renderer (`tsconfig.web.json`) and main
  (`tsconfig.node.json`)
- `node scripts/e2eNN.mjs` — CDP smoke tests; first start the app with
  `npx electron-vite dev -- --remote-debugging-port=9777`; generate the
  test media with `scripts/gen-test-media.sh` (the older suites need it;
  newer suites create their own files in `/tmp/kadr-test`). The voice-over
  suites need `KADR_TTS_MOCK=1` in the app's environment, or they would
  spend real API credits.
- Pure node checks — no app, no network:
  `node scripts/check-envelope.mjs` (loudness envelope),
  `check-ttstext.mjs` (text splitting), `check-proxy.mjs` (proxy choice),
  `check-voicemap.mjs` (time remapping after a splice),
  `check-settings-wiring.mjs` (every setting has a consumer and a row),
  `check-chats.mjs` (Claude chats round-tripping through the .kadr),
  `check-rate-control.mjs` (x264 ABR/CRF args), `check-encoders.mjs`
  (hardware encoder listing and args; with ffmpeg it probes them for real);
  `check-output-geometry.mjs` wants ffmpeg (fit/fill/stretch on output, a
  changed fps keeps the duration); `check-alpha-export.mjs` wants ffmpeg
  (codec choice, and a premultiplied title over transparency read back from
  ProRes 4444, VP9 alpha and PNG: alpha 0 outside, no dark fringe);
  `check-chapters.mjs` wants ffmpeg (G7: SRT cues and marker chapters moved
  into the export range and clipped to it, then muxed: ffmetadata chapters and
  title, a mov_text track, the `.srt`/`.vtt` sidecar);
  `check-loudness-target.mjs` wants ffmpeg (G9: a −14/−16/−23 LUFS export
  of quiet, loud, peaky and unreachable mixes to WAV, M4A and MP3 lands
  within 0.5 LU by ebur128 with the true peak ≤ −1 dBTP, and the reported
  numbers are the file's);
  `check-mixdown.mjs` wants ffmpeg too (every segment lands at its own
  timeline position); `check-fade-curves.mjs` wants ffmpeg (K2: each
  fade curve against afade's own, an equal-power crossfade of two noise clips
  within 0.5 dB in the preview's gain maths and in a mixdown);
  `check-lufs.mjs` wants ffmpeg (K3: the preview's loudness meter DSP within
  0.3 LU / 0.3 dB of ebur128 — integrated through both gates, momentary,
  short-term, true peak at 48 and 44.1 kHz); `check-pan.mjs` wants ffmpeg
  and the installed electron (K4: the real StereoPannerNode and the export
  chain against the one pan law — static, keyframed, mono (K10: at its own
  level on each channel, preview = export, premix too), hard left silent
  in R — and master −6 dB lowering the export by 6 ± 0.1 dB);
  `check-three-point.mjs` (L5: every three-point combination resolves the
  fourth point, Insert and Overwrite edit exactly that span — Overwrite trims
  what it covers, never overlaps it — patching to a track, a new one or none);
  `check-nesting.mjs` (L6: a compound clip draws and mixes like its contents
  laid out flat, loops are refused, an old project loads with every clip);
  `check-speed-ramp.mjs` (L3: source time is the integral of a speed ramp in
  every consumer — preview/export frames, frame blending, export audio chunks
  within a frame of the picture, markers, splits, trims, speed changes);
  `check-scrub-grains.mjs` (K7: scrub grains at most every 60 ms, none after
  the drag ends — not even a seek landing late — and each stops by itself;
  K12: a voice is wired through the clip's effects into its track's bus and
  plays the denoised copy, on a fake WebAudio graph, `scripts/fake-webaudio.mjs`);
  `check-mixer-binding.mjs` (K6: the fader and the header slider are one
  value, the taper table, one undo step per gesture — arrow keys on the
  header slider too — keyed edits as keys; K12: a removed track's bus leaves
  the graph, the output label is the context's real device);
  `check-record-place.mjs` (K8: a microphone take started at t with a
  pre-roll lands at t, latency compensated, ends where recording stopped);
  `check-audio-fx.mjs` wants ffmpeg (K9: the real `kadr-fx` worklet in
  128-frame quanta and the export's form within −60 dB, the EQ against
  ffmpeg's biquads, the compressor on its static curve, the de-esser's split
  band, clip effects before the gain and track effects on the sum in the
  graph and the premix, denoise of the same length with no shift and less
  hiss, a range entering a fade part-way, the bake hash and the up-mix);
  `check-eta.mjs` (G8: the export's fps / time left from
  a 5 s moving average, the bitrate × duration size, the PNG-sequence matcher
  a cancel deletes by);
  `check-recent.mjs` (H1: the recent-projects list behind «Открыть»'s ▾ and
  the empty bin — newest first, unique by path, capped at 20);
  `check-template.mjs` (H3: «Сохранить как шаблон» keeps tracks, settings,
  text clips and the user's markers and drops media, fragment clips,
  transcripts, voice runs and chats; a new project from it gets fresh ids);
  `check-bin-filter.mjs` (H4: the media bin's search — name and extension,
  any case — its stable sort, the «в деле» count with an A/V pair counted
  once, and «Неиспользуемые», all in `shared/binView.ts`);
  `check-bins.mjs` (H5: the bin's folders, `Project.bins` + `MediaAsset.binId`
  in `shared/bins.ts` — deleting a folder never deletes an asset, a parentId
  cycle or a missing folder is healed on load, a folder never moves into
  itself, and the rows the bin draws);
  `check-sequence-detect.mjs` wants ffmpeg for its last part (H6: numbered
  stills are one run only by contiguous numbering, a common stem, folder and
  extension, one padding style; a folder walk in main; a 240-frame PNG run
  becomes one 10 s H.264 clip at 24 fps, an RGBA run a VP9+alpha WebM);
  `check-proxy-choice.mjs` (H7: the bin's per-asset «Прокси: авто / всегда
  / никогда» — `MediaAsset.proxyMode`, `shared/proxyChoice.ts` — overrides
  the global toggle and threshold both ways, except that an undecodable
  codec keeps its proxy; J11: HEVC Main/Main10 is decodable when the
  platform's `canPlayType` says so);
  `check-collect.mjs` (H8: «Собрать проект» copies every path kind — media,
  transcripts, voice-over scripts and run folders, reversed renders, downloads
  and frame-run intermediates — into `<project>/media/` and rewrites them;
  paths inside the project folder are saved relative; J2: a clip's LUT too);
  `check-i18n-literals.mjs` (no Cyrillic literal anywhere outside
  `src/i18n.ts` — errors included — nor in the Python drivers, and every
  key main or a driver says is in the table) and `check-said.mjs` (H9: main has no table and no UI language, so
  it throws `saidError(key, args)` from `shared/said.ts` — a mark + JSON in
  the message, args may be Saids themselves — and returns warnings as
  `said(…)`; `speakMainErrors()` in src/i18n.ts wraps every `window.kadr`
  call at boot so a rejection arrives as the sentence in the UI language,
  and `spoken()` says a returned warning);
  `check-context-line.mjs` (I2: «Выделение — в запрос агенту», Ctrl+Shift+K
  and the panel header's target button, types `[kadr] выделено: … · плейхед
  … · диапазон …` into claude's prompt through xterm's paste, NEVER with
  Enter — project seconds and clip ids, control characters folded to
  spaces so a clip name cannot submit the prompt or end a bracketed paste;
  `src/engine/contextLine.ts`);
  `check-state-slices.mjs` (I3: kadr_state's summary of a 2000-clip project
  is small, a one-track slice is that track whole, the slices cover the
  project exactly once, and the real bridge never cuts a reply and answers a
  stuck eval with a timeout at the deadline);
  `check-words.mjs` (I4: the transcription's words are kept on its SRT doc,
  `TextDoc.words`, in source seconds like the voice defects; `placeWords` in
  `src/engine/words.ts` maps them through clip trim and speed to exactly where
  defects over the same span land, once per linked A/V pair; they survive a
  save/load and `kadr_state` gives them by slice, `fields: ["words"]`);
  `check-silences.mjs` (I5: pauses found at a speech clip's gaps on frames,
  the voice track alone under music, a transcript word kept; removing them
  shortens the timeline by gaps − 2·pad each as ONE undo step; kadr_silences
  refuses bad input before the page);
  `check-proposals.mjs` (I8: `kadr_propose` shows ranges as flags with the
  reason; only what the user confirmed is cut, in ONE undo step, overlapping
  ranges merged in `extractRanges`; apply by ids is refused, and
  kadr_silences never cuts another kind);
  `check-word-cut.mjs` (I10: the transcript panel's word deletion —
  `cutWords` in `src/engine/transcript.ts` — cuts inside the silence around
  the words, never through a phoneme: each edge is the middle of the longest
  quiet run of the `audio:envelope` in the gap (kadr_phrases' `cut_point`
  rule), on frames, ONE undo step; the proposals are shifted across that
  cut, not dropped; paragraphs, the word under the playhead, search);
  `check-batch-ranges.mjs` (I11: confirmed `short` proposals export once
  each, one at a time, named from the reason without overwriting a file or
  each other; a failure or a cancel stops the batch; a short is never cut);
  `check-scenes.mjs` wants ffmpeg (I6: scdet finds a generated clip's 4 hard
  cuts within a frame, mapped through inPoint and speed to 'scene' markers
  as ONE undo step, snap targets that survive a load; kadr_scenes refuses
  bad input before the page);
  `check-duck.mjs` wants ffmpeg (I7: on a generated voice + music pair the
  music's gain keys follow the speech spans with attack and release, an
  existing gain is multiplied, ONE undo step; the exported music dips
  12 ± 1 dB in speech and is back in the gaps; a 10-minute ducked bed mixes
  in under 3 s; kadr_duck refuses bad input before the page);
  `check-fps-rational.mjs` wants ffmpeg (H2: the Inspector's frame-rate
  presets are exact rationals — `project.fps` stores 30000/1001, ffprobe of
  an export reads it back, and every frame lands on the timeline's step);
  `check-beats.mjs [resources/music]` (beat analysis; with the folder it is
  compared beat for beat with librosa's own cues), and with ffmpeg
  `check-limiter.mjs` (the export master limiter) and
  `check-sfx-labels.mjs` (sound labels vs /brag's 228) and `check-hdr.mjs`
  (the HDR → SDR maths and ffmpeg's own filter chain against the formula);
  `check-stream-colour.mjs` wants ffmpeg (J9: an H.264/HEVC stream's colour
  description read from the SPS VUI and the colr box, mapped to the matrix
  the preview's `<video>` uses — the export re-wraps its frames by it; J11:
  the tags a proxy is written with);
  `check-decode-determinism.mjs` wants ffmpeg (J10: the real
  `Mp4FrameSource` under node with a reordering fake decoder — every sample
  of a B-frame intermediate is fed once, in decode order, and frame k comes
  back at every k, however the file's bytes and the config check interleave;
  J13: on short GOPs the first chunk after a jump is the sought key frame);
  `check-colour-math.mjs` wants the installed electron (J1: ramps drawn
  through the REAL Compositor in a hidden window match `shared/colour.ts`'s
  reference within 1/255 for every primary control, a neutral grade is
  pixel-exact, a keyframed exposure is neutral at its 0 key);
  `check-lut.mjs` wants ffmpeg and the installed electron (J2: .cube 1D and
  3D parsed, the reference sampler and the REAL Compositor within 2/255 of
  ffmpeg's lut3d/lut1d on the same pixels, an identity LUT and intensity 0
  within 1);
  `check-blend.mjs` wants the installed electron (J3: every blend mode
  through the REAL Compositor within 1/255 of the W3C formula applied to the
  two layers as drawn alone — opaque, at 0.6 opacity, over a transparent
  background, with a blur effect — and a normal draw bit-identical after a
  blend pass ran);
  `check-key.mjs` wants the installed electron (J4: a generated green screen
  keyed through the REAL Compositor, read back over black and over white,
  within 1/255 of `shared/key.ts`'s reference — chroma with and without
  spill, luma, the key before the grade, × a mask, × an alpha-packed matte;
  the backing keys to alpha 0, the edge is soft, spill 1 leaves no green);
  `check-colour-ui.mjs` (J6: every control of the Inspector's «Цвет»
  section writes through `src/engine/colourEdit.ts` ONCE per gesture — a
  slider drag of many values is one undo step, a gesture that wrote nothing
  none, every diamond/reset/mode/LUT click one; a wheel or curve-point drag
  one, a point's delete one; J14: a double-click is one step of its net
  change — the puck jump or point its first press made folds into the reset or
  delete, so a no-op leaves none; «Вставить атрибуты» carries the colour);
  `check-curves.mjs` wants the installed electron (J7: a curve passes
  through its points with no overshoot, neutral wheels and curves bake
  nothing, the baked table follows the exact function, and the REAL
  Compositor matches the reference within 1/255);
  `check-scope-bins.mjs` (J8: the scopes' counting in `shared/scopes.ts` on
  75 % colour bars — histogram spikes at 0 and 191 with the bars' shares,
  every bar on its BT.709 luma level and on its vectorscope target);
  `check-models.mjs` (3MF build items/components/units, STL, OBJ, GLB,
  decimation) and `check-timeline.mjs` (the timeline's waveform columns and
  overlap zones must EQUAL the slow code they replaced); plus
  `<python3.11> scripts/check-phrases.py` for the phrase-boundary maths.
  `node scripts/gen-sfx-catalog.mjs` regenerates
  `resources/sfx/kadr-sfx.json` after a bundled sound or
  `SFX_ANALYSIS_VERSION` changes.
- e2e44 (beats, audio-reactive bake, sound library), e2e45 (fragment
  preview stacking, hot reload of a late project-owned fragment), e2e46
  (preview at cuts, snapshots of heavy 3D), e2e47 (project library, fonts,
  render entry, typecheck), e2e48 (checks), e2e49 (3D import, kit,
  collisions), e2e50 (fragment parameters, onion skin) and e2e51 (bounded
  preview pool, timeline culling, zoom gestures) replace the open project,
  so they REFUSE to run over one with clips unless `KADR_E2E_FORCE=1`.
- `node scripts/preview-bench.mjs <from> <to>` — plays a span of the open
  project and reports editor frames, draws per fragment iframe, iframe
  processes and the worst frame at every fragment cut. Plays sound.
- `node scripts/gen-icons.mjs [dir]` — regenerate `src/components/icons.tsx`
  from lucide (see the header for the two-line fetch); never hand-edit the
  paths.
- `node scripts/hold-viewport.mjs [w] [h]` — force the page's layout
  viewport while coordinate-driven suites run (a tiling window manager can
  pin the editor window at a size those suites do not expect).

## Requirements
- Node.js ≥ 20, system `ffmpeg`/`ffprobe` in PATH
- Optional: Python + `faster-whisper` (speech-to-text), the `claude`
  CLI (embedded AI assistant), network access for the one-time Remotion
  workspace install
- Optional for voice-over: an ElevenLabs API key (entered in the app,
  stored outside the project); for the defect detector, python ≥ 3.11
  with `torch` — the interpreter is a setting (`KADR_TTSQC_PYTHON`), and
  the module degrades to plain voice-over when it is missing

## Architecture
- `shared/types.ts` — the entire project model (Project/Track/Clip/Anim/
  Keyframe, TextDoc, FragmentSpec, ExportPreset/ExportJob, the `KadrApi`
  IPC surface). All times in seconds. `Anim` is a scalar that may carry
  keyframes; `evalAnim` interpolates. `tracks[0]` is the top video track
  (drawn last) of the OPEN timeline.
  SEVERAL TIMELINES AND COMPOUND CLIPS (L6, `shared/timelines.ts`,
  `src/engine/nesting.ts`): `project.timelines` lists every timeline; the
  open one's tracks stay in `project.tracks` (its entry carries none), so
  every editing and render path reads that field as before, and what is
  project-wide — paths, collect, storage, the bin's «in use», removing a
  source — goes through `allTracks`. Absent = one timeline: an old project
  loads unchanged. A clip of kind 'timeline' (`timelineId`; `inPoint` is a
  second of that timeline) plays another one. THE RENDERERS NEVER SEE IT:
  `flattenProject` replaces it by its contents cut to its window, their
  tracks stacked where its track is (sound tracks after the rest), ids
  `<compound>/<clip>` — the preview's Player, the export, every audio
  mixdown (`collectRangeAudio`, whose clip/track filters take a compound's
  contents along), the fragment pages, the snapshot and the scrub; cached
  per project object. So a nest of untouched clips exports frame-identical
  to them laid out flat. Its own gain, pan (K6: added to each clip's) and
  mute reach the contents, and an audio host track's effects (K9) its sound
  tracks that have none of their own; its
  transform, effects, fades, edge tips and speed would need the nest drawn
  into a texture first, so the Inspector and the clip view do not offer them.
  Loops are refused where they would be made (`nestsInto`) and a hand-written
  one, or a nest deeper than 8, draws nothing. Tabs over the tracks once
  there are two (`TimelineTabs.tsx`); double click opens a compound.
  Test: `node scripts/check-nesting.mjs`.
- `electron/main.ts` — window, `kadr://` streaming protocol with manual
  Range support, IPC: dialogs, project IO, export, user stores, proxy queue, reversed-media cache, media intake
  (`media:download` — browser-URL drops fetched into `userData/imported`,
  cached by URL hash; `media:save-blob` — path-less Files / data: URLs /
  clipboard images, cached by content hash; `media:portal-files` — XDG
  FileTransfer portal drops resolved over the session bus via gdbus;
  `media:clipboard-paste` — copied files or a copied image). A malformed
  `DBUS_SESSION_BUS_ADDRESS` in the launching environment silently breaks
  portal drops — main normalizes it to the live user socket at startup.
  The scheme MUST stay registered with `corsEnabled: true` (+ ACAO:*
  responses and `crossOrigin='anonymous'` on media elements incl. Image)
  — modern Chromium otherwise taints kadr:// pixels and preview/export go
  black. Those same privileges (plus `bypassCSP`) make the scheme a
  file-read capability, so every URL carries a per-run token: `fileUrl` in
  the preload appends `?t=<48 hex>` (fetched once over a sync `media:token`
  IPC) and the handler 403s anything else. Without it a page served by the
  FRAGMENT dev server — another origin, no node access, i.e. composition code
  written by hand, by an assistant, or arriving inside somebody else's
  project — could read any file the user can. A directory allowlist was
  considered and rejected: media lives wherever the user picked it, and a
  project loaded through `kadr_eval` never passes main at all, so the
  allowlist would have had holes exactly where a miss means a black preview. Startup sweeps leftover helper processes; shutdown force-exits
  (window-all-closed → app.exit failsafe, render-process-gone → exit).
  EVERY PROJECT AND USER-STORE WRITE IS ATOMIC (`electron/atomicWrite.ts`):
  save, autosave and `store:write` write `<path>.part-<pid>`, fsync, then
  rename over the original — a plain writeFile of a ~78 MB project tears the
  user's only copy on a crash or a full disk. A failed write leaves the
  original byte-identical and removes the sidecar; Windows refuses a rename
  over a file another program holds open (antivirus, sync client), so the
  rename is retried 3× with backoff first. Test:
  `node scripts/check-atomic-write.mjs`.
  NOTHING REPLACES UNSAVED WORK WITHOUT A QUESTION: New, Open and closing
  the window (×, Alt+F4, a quit) go through `confirmDiscard` in App.tsx —
  Save / Don't save / Cancel, asked only when `needsConfirm` (the dirty-dot
  rule, `src/engine/discardGuard.ts`) says so. main cancels the window's
  `close` (and turns `before-quit` into a close) and waits for the page's
  `app:close`; a page that has not registered its handler, a crashed or an
  unresponsive one is not asked, so the window can always be closed.
  `kadrEditor.openProject(path)` asks too; scripts pass `{ force: true }`.
  Test: `node scripts/check-discard-guard.mjs`.
  ONE EDITOR PER userData (`requestSingleInstanceLock`, taken right after
  `KADR_USER_DATA` is applied — the lock is keyed by that path, so a sandbox
  runs next to a live Kadr): a second launch quits and hands its argv over;
  the first focuses and opens a `.kadr` from it through the same question
  (`app:open-project`; the launch's own `.kadr` is fetched once over
  `app:argv-project`). Test: `node scripts/check-argv-project.mjs`.
- `electron/ffmpeg.ts` — ffprobe probing (+ thumbnails + peak/RMS waveform
  bins), `makeProxy` (540p preview proxies — J11: TAGGED IN FULL with the
  space the preview shows the source in, `proxyColour` in
  `shared/streamColour.ts`; left untagged, ≤540 lines fell under the
  element's height guess and an HD source played BT.601 whenever proxies were
  on; `:c` in the proxy key rebuilds the old untagged ones), `makeReversed` (backwards
  render of a clip's source range, RAM-bounded chunks), `ExportMuxer`
  (per-segment `volume,atempo*,afade,adelay,asetpts,apad,atrim` → `amix`
  with exact level compensation), `RawVideoEncoder` (fallback raw-frame
  encoder; the primary one is spawned by the preload).
  THE `asetpts` AFTER `adelay` IS LOAD-BEARING: on some builds (seen on
  gyan.dev git 2025-01-08, Windows) `adelay` stamps its padding NOPTS when
  the input is an A/V file opened with `-ss`, the `atrim` then throws the
  padding away, and EVERY segment lands at t=0 — an export whose audio is
  all of the timeline piled onto the first seconds and silence after the
  longest clip. Recounting pts from the sample position is version-neutral
  and costs nothing. Test: `node scripts/check-mixdown.mjs`.
  KEYFRAMED CLIP GAIN reaches the mix: the collector samples the clip's gain
  Anim with the preview's own `evalAnim` into `AudioSegment.gainKeys`
  (segment-local timeline seconds, piecewise linear — eased and smooth spans
  in ≤ 32 pieces, `shared/gainKeys.ts`), and `segmentChain` applies them
  after atempo as one `volume='<expr>':eval=frame` in 10 ms steps — so the
  graph and the premix both get it. The expression picks its piece through a
  balanced tree of `if(lt(t,…))` (ffmpeg evaluates only the taken branch):
  as a flat sum of pieces a ducked 10-minute bed (~600 keys) took 4.9 s to
  mix, as a tree 0.4 s. A gain that never changes stays a
  scalar and mixes bit-identically. Test: `node scripts/check-gain-keys.mjs`.
  The keys are drawn on the clip's level line (K1, see Timeline below).
  FADE CURVES (K2, `shared/fadeCurves.ts`): `Clip.fadeInCurve`/`fadeOutCurve`
  — lin, qsin (equal power), log, exp — shape the clip's audio fades AND the
  automatic crossfade over an overlap. One table: `fadeFactor` multiplies the
  preview's element volume by it (given `overlapFades`, which carries the
  curves; video opacity stays linear) and `segmentChain` names the same curve
  to afade (af_afade.c's formulas). ABSENT = LINEAR, so a project from before
  sounds the same; `editing.fadeCurve` (default qsin) is STAMPED into each new
  clip like the default transition, so new overlaps hold their loudness where
  a linear pair dips ~3 dB. The curve is picked from the fade handle's
  right-click menu. Test: `node scripts/check-fade-curves.mjs`.
  A segment carries the WHOLE fade window and where it stands in it
  (`fadeInFrom`, `fadeOutPast`): a range export or a source loop that starts
  inside a fade used to restart it from zero. afade takes no negative start,
  so `fadeChain` pads the segment with that much silence, fades, and trims
  the padding off (test: `check-audio-fx.mjs`).
  PAN AND THE MASTER FADER (K4, `shared/pan.ts`): `Clip.pan` (clip-local keys)
  plus `Track.pan` (project-time keys), −1…1 as Anims, summed and clamped
  (`panAt`); absent = centre and no filter at all, so an old project mixes
  bit-identically. ONE LAW: the preview's StereoPannerNode (element → gain →
  pan → master, `PANNER_OPTIONS` upmixing mono first) and the export's
  `segmentChain`, which replays that node's stereo algorithm as a `pan=`
  matrix after the upmix, or per sample as `aeval` when the pan moves — so the
  premix gets it too. `Project.masterGain` (linear, absent = 1) is the master
  GainNode in the preview and a `volume` in front of the export's limiter;
  analysis mixdowns and a loudness target (which sets the level itself)
  ignore it. A MONO source is upmixed at UNITY on both sides (K10): WebAudio
  copies it into each channel, while ffmpeg's aformat alone puts it −3 dB a
  side (swresample's M_SQRT1_2, `clev` does not reach it) — a mono voice-over
  used to export 3.01 dB under what was heard. The import probe keeps
  `MediaAsset.channels`, segments carry it, `ExportMuxer.run` asks ffprobe only
  for an asset from before that (once per path + mtime — a spawn costs ~1 s on
  Windows), and `segmentChain` puts `pan=stereo|c0=c0|c1=c0` in front of the
  aformat of a 1-channel source, in the premix too. A named-channel `pan`
  (FL=FL+FC) would need no probe, but 5.1 wants FC at −3 dB, so it cannot. Test: `node scripts/check-pan.mjs`.
  TWO LIMITS A BIG TIMELINE WALKS INTO, both met on a real 19-minute edit
  carrying ~1000 SFX clips. One graph with N padded inputs costs the ffmpeg
  scheduler roughly QUADRATICALLY in N: that mix ran at a quarter of realtime —
  80 minutes of muxing for 19 minutes of video. Past `PREMIX_THRESHOLD` (64)
  segments, `premixSegments` decodes each segment separately through the SAME
  chain (`segmentChain`: volume, atempo, fades) to f32 PCM and sums it into one
  buffer at its timeline offset — linear in total clip length instead of
  quadratic in clip count — and the muxer then sees a single input. Levels are
  identical by construction: amix divided every input by N and the following
  `volume=N` undid it, so a plain sum lands in the same place. NB that buffer is
  held whole in main: 48 kHz stereo f32 is ~23 MB per minute of timeline.
  The other limit is argv: Linux caps ONE argument at 128 KB (MAX_ARG_STRLEN),
  and that many clips build a `-filter_complex` past it — spawn failed with
  E2BIG. The graph is written to a file and passed by file, on every export
  rather than only the big ones. THE OPTION DEPENDS ON THE BUILD (K11):
  `-filter_complex_script` was deprecated in 7.1 and REMOVED in 8 («Option not
  found» — every export with sound failed), while 4.3 knows no other spelling
  than it; `filterGraphFileOption` runs a one-line graph through
  `-/filter_complex <file>` once per binary path and falls back to the old
  option when that fails. Test: `node scripts/check-mixdown.mjs`.
  EXTRAS (`ExportJob.extras`, shared/exportExtras.ts) arrive in EXPORT time —
  the renderer maps the transcript to the timeline and cuts cues and chapters
  to the range; the muxer adds an `-f ffmetadata` input (title, chapters,
  `-map_metadata`/`-map_chapters`), an srt input as `mov_text` for mp4/mov, and
  writes the sidecar next to the output only after ffmpeg succeeded.
  A FAILED MUX NO LONGER BINS THE VIDEO: the stream is rendered first and can
  take hours, and the mux ran with that temp file scheduled for deletion in
  `finally`. A non-cancelled failure that has video keeps it, and the error
  message says where it is.
- `electron/claude.ts` — embedded Claude Code: node-pty PTY running the
  user's `claude` CLI inside a watchdog wrapper (kills its process group
  if Electron dies hard), per-session HTTP bridge (POST /eval →
  `webContents.executeJavaScript`); extra env via
  `userData/claude-env.json`, extra MCP servers via
  `userData/claude-mcp.json`. SESSION OPTIONS are settings (`claude.*`):
  `command` (env `KADR_CLAUDE_CMD`; wins over the JSON's), `model`,
  `permissionMode` (default/acceptEdits/auto/plan — NEVER
  bypassPermissions: the agent has a shell; the enum refuses it and
  `claudeArgs` drops every skip/bypass spelling from extra args too),
  `strictMcp` (default ON: `--strict-mcp-config`, so the user's global MCP
  servers stay out and only the bridge + claude-mcp.json load), and
  `extraArgs`, one line APPENDED after Kadr's flags. A legacy `args` in
  claude-env.json still REPLACES them (a wrapper that may not be claude);
  `claude:status` reports it for the settings row's warning, together with
  `claude auth status --json` (no tokens; its tree is killed at 15 s — a
  .cmd shim's node outlives execFile's own timeout). `sweepStaleSessions()` clears leftovers of
  hard-killed runs at startup (after the page loads). On Windows there is no
  /proc: one PowerShell `Win32_Process` listing, and a process is killed
  (`taskkill /T`) only if its command line carries a Kadr path AND its parent
  is gone — the user's own node or ffmpeg in the same folders has a live
  parent (`electron/orphanSweep.ts`, test `node scripts/check-sweep-match.mjs`).
  Measured: a `taskkill /F` of Kadr mid-render takes every non-detached
  helper down with it (libuv's kill-on-close job, the pty's closed console),
  so what the sweep meets there is a detached one.
  Open and close are SERIALIZED through one promise chain and carry a
  generation: spawning is async (config read, `which`, the node-pty import)
  while a close is instant, so a close that overtakes an in-flight open would
  otherwise find no session, do nothing, and let the pending spawn install
  itself afterwards — an orphan nobody can reach or kill. React StrictMode
  turns that race into the norm in dev (it mounts the panel twice), which used
  to give every panel open two ptys writing into one terminal. Both pty
  handlers are keyed to their own session object, so a pty that outlived its
  panel can never paint into the live terminal.
  /eval IS AUTHENTICATED and must stay that way — it runs arbitrary JS in
  the page, and the page holds `window.kadr` (file writes, pty spawn), so a
  bare localhost socket would be reachable by anything on the machine and by
  any WEB PAGE too (a cross-origin fetch with a simple content type needs no
  permission, and an unreadable reply does not stop the code from running; a
  fragment previewed from the workspace dev server is such a page). Two
  locks: a per-session random token in an `x-kadr-token` header — a custom
  header forces a preflight, which the server 404s, so a page cannot even
  send the request — and a flat refusal of any request carrying an `Origin`.
  The token reaches the MCP server as argv[3] of the generated config; the
  liveness ping on `GET /` stays open.
  AGENT TURNS ARE CHECKPOINTED: the undo stack holds 50 steps, so an agent
  turn of more edits pushed its own start out of undo, and pushing history is
  only a convention the agent is told about. main marks a turn boundary on
  the bridge (`shared/agentTurn.ts`): the first /eval after the user's last
  keystroke in the panel (xterm's own focus/cursor replies do not count), or
  after 20 s with no eval running — measured from the END of the last one, so
  a long export never splits a turn. The first eval of a turn calls
  `kadrEditor.agentTurn()` before its code: `agentCheckpoint` copies the
  project into a ring of 10 OUTSIDE undo (an unchanged object is not copied
  twice) and autosave writes a backup. «Откатить ход агента» in the panel
  header restores the newest checkpoint as ONE undo step (the user's own
  edits during the turn go too — the confirm says so) and drops it, so a
  second click walks back the turn before. Test:
  `node scripts/check-agent-turns.mjs`. Every /eval is also bracketed by
  `kadrEditor.agentEval(±1)`, and an undo entry pushed inside one carries
  the turn's start (`HistEntry.turn`, kept through undo and redo): the
  HISTORY LIST (L2, the ▾ beside undo/redo in the transport) marks those
  rows with a bot glyph and a heading per turn; a click on a row is
  `jumpHistory(n)` — exactly n undos (or −n redos), nothing cleverer. A
  track's mute and lock are undo steps, like its solo, name and colour.
  Test: `node scripts/check-history-jump.mjs`.
  On Windows there is no bash and no process groups: the command is found
  with `where` (npm's extensionless sh shim is skipped), claude runs directly
  in the pty, and a close kills its tree with `taskkill /t`.
- `electron/chats.ts` — the project's Claude chats. `Project.claudeChats`
  holds session ids; the panel resumes the newest (`--resume`) or starts one
  with a known id (`--session-id`), and its header picks between them. Both
  project writers embed the transcripts as `claudeTranscripts: {id: jsonl}`
  unless `claude.embedChats` is off (then only the ids go — sending the
  file sends no conversations; they resume from Claude's own store);
  `project:read` takes them out again and keeps them in main — THEY NEVER
  REACH THE RENDERER, whose project is deep-copied on every edit. Claude Code
  only resumes from `<config>/projects/<slug of cwd>/<id>.jsonl`, so right
  before a resume the longest known copy (any slug folder, or the opened
  file) is written there — a chat begun in an unsaved project (cwd = home)
  or on another machine resumes in the project's folder. Transcripts only
  grow: between two copies the longer wins. A chat joins the project on the
  user's first key or paste in that session (`noteClaudeChat`, always a new
  project object — the unsaved dot and autosave must see that the file's
  transcript is behind); ids with no transcript are dropped on save. Undo/
  redo carry the CURRENT chat list over, since a chat is not an edit. The
  panel is keyed by project id, so opening another project brings up ITS
  chats. A legacy args replace in claude-env.json runs something that may not be
  claude, so it gets no chat flags and its sessions are not tracked. NOT
  TRACKED either: a session switched inside the TUI (`/clear`, `/resume`) —
  claude gives it an id the panel never sees; «New chat» is the way.
  AGENT SKILLS are composable and load PER SESSION: `electron/claude-plugin`
  is a plugin named `kadr` that the panel's claude gets with `--plugin-dir`
  (args built by the pure `claudeArgs` in `electron/claudeArgs.ts`, test
  `node scripts/check-claude-args.mjs`) — `kadr:editor` (the base: LOOK →
  ACT → VERIFY, the interface, fragments, voice), `kadr:music`,
  `kadr:motion`, `kadr:3d`, loaded as a project needs them (the system hint
  says so); their rules are defaults. They used to be copied into
  `~/.claude/skills`, which listed them in EVERY claude session on the
  machine; at startup `removeManagedSkills` deletes the `kadr-*` copies
  carrying the old `<!-- managed by Kadr` mark, never a folder without it
  (the user's own). The plugin's files are LF (`.gitattributes`): the old
  front-matter regex skipped every skill on a CRLF checkout. A legacy
  `args` replace in claude-env.json drops the flag too (no skills);
  `claude.extraArgs` appends and keeps it.
- `electron/mcp-bridge.cjs` — MCP stdio server (SDK) that claude receives
  via a generated `--mcp-config`; tools: kadr_state / kadr_eval /
  the semantic edits kadr_cut / kadr_move / kadr_trim / kadr_ripple_delete /
  kadr_keyframe / kadr_text_add / kadr_volume / kadr_grade (J6: the colour
  section — grade, LUT, blend, key; J7 wheels, curves) / kadr_marker / kadr_undo
  (`electron/mcp-edit-tools.cjs` → `kadrEditor.agentEdit`,
  `src/engine/agentEdits.ts`: zod-checked before the page, one store action
  and EXACTLY one undo step each — an edit that changes nothing leaves no
  step and errors; test `node scripts/check-mcp-tools.mjs`, which also parses
  the bridge: a syntax error there silently leaves the agent with no tools) /
  kadr_silences (I5, `src/engine/silences.ts`: pauses from the
  `audio:envelope` of a clip / range / tracks with a 5 ms release, the
  threshold relative to the analysed peak, transcript words kept; shown as
  proposal flags on the timeline — the toolbar's «Паузы» and the palette
  do the same — and cut with `extractRanges`, all of them ONE undo step;
  test `node scripts/check-silences.mjs`) /
  kadr_propose (I8: the agent's ranges with a reason — retakes read off the
  transcript words — in the SAME proposal store and flags as the pauses,
  per `kind`; the tool can only apply what the USER confirmed; test
  `node scripts/check-proposals.mjs`; kind `short` (I11) is NEVER cut —
  `applySilences` skips it — and the export dialog's «Экспортировать
  выбранные» renders each confirmed one to its own file named from the
  reason (`src/engine/shorts.ts`: « (2)» for a name already on disk or in the
  batch), one `startExport` after another; test
  `node scripts/check-batch-ranges.mjs`) /
  kadr_scenes (I6, `src/engine/scenes.ts`: ffmpeg `scdet` in main,
  `media:scenes`, over the source span of every video clip in a clip /
  range / the timeline; the cuts become `TimelineMarker.kind = 'scene'` —
  thin lines like beats, snapped under «Маркерам» — replacing the scene
  markers of that stretch in ONE undo step; also the palette's «Найти
  склейки в видео»; test `node scripts/check-scenes.mjs`) /
  kadr_duck (I7, `src/engine/duck.ts`: speech = the `audio:envelope` of the
  other tracks (or the named ones) above −35 dB of its peak plus transcript
  words; the music clips get gain keys — −12 dB, 0.3 s attack before speech,
  0.5 s release after, recoveries under 0.5 s merged — MULTIPLIED into the
  gain they had, ONE undo step labelled so; also the clip menu and the
  palette's «Приглушить музыку под речью»; test `node scripts/check-duck.mjs`) /
  kadr_snapshot / kadr_sheet / kadr_export / kadr_transcribe /
  kadr_fragment_create / kadr_typecheck / kadr_check / kadr_fragment_media /
  kadr_model_import / kadr_models / kadr_neon_wave / kadr_beats /
  kadr_audio_react / kadr_sounds / kadr_sound_add / kadr_sound_label /
  kadr_voice_*.
  NO REPLY IS CUT (I3): a whole-project `kadr_state` outgrew a tool reply and
  was sliced mid-JSON at 4 MB, which the agent read as a (wrong) whole. It is
  now a SUMMARY by default (tracks with clip counts, marker counts by kind,
  selection, playhead, range) and exact slices by `tracks` / `range` /
  `fields` (`sliceState`, `src/engine/agentState.ts`); a slice over
  `STATE_BUDGET` (100 KB of compact JSON) is REFUSED with a narrower range to
  ask for, and any other tool's result over 4 MB is refused too, never cut.
  EVERY CALL HAS A DEADLINE: 60 s (`KADR_MCP_TIMEOUT_MS`), 30 min for the long
  tools (export, transcribe, voice, fragments, beats, checks, sheet, 3D
  import), `kadr_eval` takes `timeoutSec` — /eval runs whatever the page
  does, and a page that never answered hung the agent with it. The page code
  keeps running after a timeout; the error says so. Test
  `node scripts/check-state-slices.mjs` (the real bridge over MCP stdio).
- `electron/transcribe.ts` + `scripts/transcribe.py` — faster-whisper
  runner (VAD, anti-hallucination thresholds and post-filters, NDJSON
  segments with word timestamps); audio comes from an ExportMuxer mixdown
  (WYSIWYG). THE INTERPRETER IS RESOLVED, never a bare `python3` — on a
  stock Windows that name is the Microsoft Store stub. `electron/speechPython.ts`
  tries `KADR_PYTHON`, the app's own `.venv`, `py -3` (Windows), `python`,
  `python3` and takes the first that imports faster_whisper (once per launch;
  a miss names every candidate and why). With its own setting empty, the detector
  takes that interpreter only if it is ≥ 3.11 and imports torch, else
  `python3.11` (`detectorPython`). Test:
  `node scripts/check-python-resolve.mjs`. The runner uses CUDA/float16 when
  ctranslate2 sees a GPU (`KADR_WHISPER_DEVICE=cpu|cuda|auto`; on Windows the
  pip `nvidia-*` wheels' DLL folders are registered) and redoes the job on
  the CPU if the GPU load or its first kernel fails before any segment went
  out; the session log names the interpreter and the device.
  THE WORDS STAY (I4): `transcribeFlow` keeps whisper's word timestamps on
  the SRT doc (`TextDoc.words` {t0, t1, w, p}, the doc's own cue time — source
  seconds for an asset-bound doc, so edits never stale them; ~50 bytes a
  word, a 1-hour talk ≈ 450 KB in the project). The SRT file is unchanged.
- `shared/envelope.ts` + `electron/envelope.ts` — loudness envelope of a
  timeline range (Blender "Bake Sound to F-Curves" semantics: channels
  summed, |s|, one-pole follower with 5 ms attack / 200 ms release, frame
  sampling by linear interpolation), computed in main over an ExportMuxer
  mixdown (`audio:envelope` IPC). Feeds `src/engine/neonWave.ts` — the 🌊
  neon-wave generator: an audio-reactive fragment whose TSX bakes the
  envelope (`ENV`) and style (`S`); the final look pass replays Blender's
  compositor Lens Distortion exactly in a WebGL shader (per-axis uv·sc
  with sc = 1/(1+max k), d = 1/(1+√(1−4k·r²)), per-channel k for
  dispersion). Empty segments short-circuit to zeros — ExportMuxer with
  no inputs builds an ffmpeg command without any `-i` and fails.
- MUSIC — beats, audio-reactive fragments, the sound library (taken over
  from /brag, latent-spaces/brag; bundled media and licences in
  `resources/`, see `resources/CREDITS.md`).
  `shared/audioAnalysis.ts` ports librosa 0.11's `beat_track` (onset
  strength over 128 Slaney mel bands, autocorrelation tempogram with a
  log-normal prior at 120 BPM, Ellis' DP, the 0.11 trim rule) and matches it
  beat for beat on the bundled tracks. Traps encoded in check-beats: librosa
  0.10 and 0.11 trim differently, `np.hanning(5)` is symmetric while
  `get_window('hann', 5)` is periodic, Python's `round` is half-to-even, and
  the onset envelope is shifted by 3 frames on purpose. Analysis runs at
  44.1 kHz: at 22.05 the tempo is quantised too coarsely to report right.
  THE GRID IS MOVED ONTO THE ATTACKS when librosa's is systematically off
  (`alignBeatsToAttacks`): on a brickwalled track whose 808 starts out of a
  sidechain gap, the onset-strength peak comes when the note is already
  sounding, and every beat sat ~110 ms after the bass. The analyser keeps
  1 ms energy envelopes (< 150 Hz and full band); per beat the attack is the
  steepest rise in [−180, +60] ms at −6 dB of the level it rises to; the grid
  moves only when ≥ 60 % of beats have one, their IQR ≤ 50 ms and the median
  is beyond 25 ms. On the bundled tracks nothing moves, so the parity holds;
  `analyzeBeats(a, { alignAttacks: false })` is the raw grid. Traps: a 5 ms
  RMS of a 50 Hz note dips at every zero crossing (the low band needs
  ≥ 20 ms), a smoothed envelope needs a rise span as wide as its window, and
  a centred window of width W crosses −6 dB of a step W/4 early. Not fixed by
  it: places where the tracker loses its phase outright.
  Beats are markers (`TimelineMarker.kind = 'beat'`) drawn as thin lines;
  `snapPoints` includes every target the magnet's menu leaves on (`editing.snapEdges/
  Playhead/Markers/Beats`) and takes marker ids in `exclude`; `snapTo` applies the
  radius and reads the magnet itself (`editing.snap`, N) live, so N mid-drag works.
  `src/engine/audioReact.ts` bakes the sound under a fragment into
  `audio.json` + `audio.ts` in its folder (per composition frame; τ plays at
  `clip.start + (τ − inPoint)/speed`; ±8 s of context for a steady tempo);
  `clip.audioBake.hash` makes the Inspector say stale, and the exporter
  re-bakes stale ones before rendering.
  `electron/sounds.ts` + `shared/sfxFeatures.ts`: the library. Labels were
  REVERSE-ENGINEERED from /brag's published ones (magnitude share in
  4–16 kHz, frames within 18 dB of the loudest; depth-2 trees agree
  96–99 %); inputs must be the channel MEAN (ffmpeg `-ac 1` scales stereo by
  √2) over EXACTLY the container duration, zero-padded (`sfxMono`): ffmpeg
  ≥ 5 applies an Ogg's end trim and decodes up to 128 frames short of it, and
  a cut-only decode moved activeRatio off /brag's. A sound's HIT (attack of
  its loudest event) is what `addSound` puts on the beat; a sound with no
  single event gets hit 0. The user's own
  sounds live in `userData/sfx/<family>/`, analysed once and cached by
  size+mtime+`SFX_ANALYSIS_VERSION`. `placeAudio` picks an audio track FREE
  over the whole span (overlap on one track would crossfade the music).
- `shared/audioMaster.ts` — the export master limiter: the mix used to reach
  the encoder over full scale. alimiter at −1 dBFS; ffmpeg 4.3's alimiter
  delays by its look-ahead (239 samples at 48 kHz / 5 ms) and never flushes
  it, so the chain pads 239 samples in front and trims them after — bit
  identical and the same length below the limit. Analysis mixdowns pass
  `master: false`. THE LOUDNESS TARGET (G9, `ExportPreset.loudness`, the
  dialog's «Громкость»; absent = the chain above, string for string) premixes
  the mix to one float WAV even under `PREMIX_THRESHOLD` and meters it with
  ebur128 (`loudnessOf`; loudnorm's pass took 21.5 s where ebur128 takes 4.6 s
  on 19 minutes) — then `fitLoudness` puts a linear `volume=…dB` in front of
  the limiter and corrects gain AND ceiling through the real chain, ≤ 5
  passes: the limiter holds SAMPLE peaks, the ceiling is a TRUE peak
  (`TP_AIM` −1.5), and gain the limiter eats whole (sparse full-scale hits
  over silence) stops the search instead of crushing the mix. The FILE is
  metered after the encode, and the codec moves what the chain measured: a
  lossy decode can go over −1 dBTP (impulses through AAC 128k: −0.9) and
  cutting the top octave takes loudness away (white noise, AAC 128k: 1.6 LU),
  so up to two re-encodes lower the ceiling under the overshoot and move the
  gain by the drift. The measured
  LUFS/dBTP ride the `done` progress event. 19 min / 200 clips: 25 → 42 s.
  Test: `node scripts/check-loudness-target.mjs`. THE PREVIEW IS LIMITED THE SAME WAY: `shared/previewLimiter.ts`
  ports alimiter (n7.1, asc and auto-level off) line by line and runs as an
  AudioWorklet between the preview's master and its analyser, so the meter
  and `audioStats().peakDb` read after it; `useSettings.previewLimiter`
  (default on) takes it out. Bit-identical to ffmpeg's on the same float
  input at 48 and 44.1 kHz. Live it cannot trim its look-ahead: preview audio
  runs 5 ms behind the picture, far under the player's resync tolerance.
  Test: `node scripts/check-preview-limiter.mjs`.
  THE PREVIEW IS METERED (K3, `shared/loudness.ts`): BS.1770-4 K-weighting
  (libebur128's per-rate coefficients), momentary 400 ms, short-term 3 s,
  integrated with the −70 LUFS and −10 LU gates, true peak by a 4×
  Hann-windowed sinc of 24 taps per phase (16 read white noise 0.3 dB under
  ebur128). A second processor in the limiter's worklet module, fed by the
  analyser, so it reads what reaches the speakers; it keeps one energy per
  100 ms, never samples. `loudness()` / `resetLoudness()` on kadrEditor and
  `audioStats().loudness`. `silencePreview` zeroes the master, so it silences
  the meter too — measure with the context's `setSinkId({type:'none'})`.
  Live, a 10 s playthrough read −24.22 LUFS where ebur128 on its export read
  −24.2. Test: `node scripts/check-lufs.mjs`.
  THE OUTPUT DEVICE AND THE SCRUB (K7). `playback.audioOutput` (a deviceId,
  absent = the system default) is one `setSinkId` on the preview's single
  AudioContext — the popped-out preview and the scrub included; only a CHANGE
  of the setting is applied, so a test's `{type:'none'}` holds. Dragging the
  playhead on the ruler while stopped plays ~80 ms grains of every audible clip
  at most every 60 ms, from `<audio>` elements of their own routed as the
  pool's are — the clip's effects, gain, pan, its track's bus and effects,
  master — and from the denoised copy once built (K12: `denoisedFor`, one rule
  for playback and the scrub), so a de-essed voice scrubs as it plays
  (`src/engine/scrub.ts` core, `scrubAudio.ts` glue): the pool's elements
  belong to the resync. A grain is timed from its seek
  landing, a seek that lands after the drag is dropped, and every grain stops
  itself, so a lost pointerup cannot leave a sound running.
  `kadrEditor.scrubStats`. Test: `node scripts/check-scrub-grains.mjs`.
  THE MIXER (K6, `src/components/Mixer.tsx`, writes in `src/engine/mixer.ts`):
  a dock right of the timeline's lanes («Микшер» in its toolbar, open state in
  localStorage), one strip per AUDIO track plus the master. The fader IS
  `Track.gain` / `project.masterGain` through ONE taper table
  (`shared/fader.ts`: +6 → 1, 0 → 0.8 … −40 → 0.14, −60 → 0) that the
  Inspector's gain range shares; the strip and the track header write through
  the same functions, and mute now pushes an undo step like solo. A track's
  gain stays in each element's gain (the sound did not change); what a strip
  meters is a per-track BUS GainNode at unity between the elements' pan and
  the master, tapped by a splitter into two analysers (`trackPeaks`,
  `masterPeaks` after the limiter); a track that is gone takes its bus out of
  the graph (`pruneBuses`, every sync of the player — undo gets a fresh one,
  which is why an element's route is remembered as the NODE, not the track
  id). The master's device label is the context's real `sinkId`
  (`outputDevice`): a switch that failed leaves the sound where it was, and the
  label with it — the setting is only the wish. «Микшер в отдельном окне»
  (canvas K, RULES 3; `popout.ts`, `useMixerPopout`) renders the same
  `MixerDock` through a portal into a window of its own at full width; the
  subtree reads its window from the `HostWindow` context (`CtxMenu.tsx`) for
  its meter loop, timers, menus and outside clicks, and the AudioContext stays
  the editor's. The limiter worklet posts its gain
  reduction 10×/s (`limiterInfo`). The loudness worklet takes 'pause'/'run':
  while stopped nothing is fed (the filter's tail drifted the integrated value
  −18.60 → −18.67 in 3 s) and M/S read −∞; playback that starts where the
  playhead was MOVED to since the stop resets the measurement, a resume does
  not. Keyed pan or clip gain take an edit as a key under the playhead, never
  `.value`. Test: `node scripts/check-mixer-binding.mjs`.
  RECORDING (K8, `src/engine/record.ts`, `shared/recordPlace.ts`): a track is
  ARMED from its header or strip (runtime only, never in the project); an armed
  track holds its input open (getUserMedia, no echo cancel / noise suppression
  / AGC, per-track device) and its strip meters that input. Record (Shift+R,
  the transport's button, which shows once a track is armed) plays from
  `playback.recordPreroll` s before the playhead — or from the range's start
  to its end (punch-in) — past the timeline's end and with the loop off, while
  a `kadr-capture` processor in the limiter's worklet module records each armed
  input mono from before the count-in. Each playhead update is paired with
  `ctx.currentTime`; the median of their difference maps the capture's first
  frame onto the timeline, and the clip's inPoint skips the pre-roll plus the
  input latency (`MediaTrackSettings.latency` + `playback.recordOffsetMs`, the
  knob for a loopback-measured device). Stopping playback ends the take: 16-bit
  WAV through `media:save-recording` into `<project>/media/recordings`, or
  `userData/recordings` (a REFERENCED storage group) unsaved; every take is
  placed by `placeAudio` on its own track when free there, all ONE undo step;
  undo keeps the files. MICROPHONE PERMISSION: main's
  `setPermissionRequestHandler` grants `media` only to the editor's own TOP
  frame and only audio — fragment iframes run in the same webContents and get
  nothing; other permissions keep Electron's grant-all default.
  Test: `node scripts/check-record-place.mjs`.
  AUDIO EFFECTS (K9, `shared/audioFx.ts`): EQ (RBJ biquads: low cut, low
  shelf, peak, high shelf), compressor (feed-forward, stereo-linked peak,
  Giannoulis-Massberg-Reiss soft knee, gain smoothed in dB) and de-esser (a
  high-pass detects, x − lowpass(x) is turned down — in phase, and the input
  comes back exactly when nothing is reduced) are ONE DSP: the preview runs
  it in the `kadr-fx` processor of the limiter's worklet module, the export
  runs the same code in main. `Clip.audioFx` sits between the element and its
  gain, `Track.audioFx` on the track's bus (bus → fx → the strip's tap), as
  in Premiere/Resolve; parameters are Hz/dB/ms, so the 44.1 kHz preview and
  the 48 kHz export compute their own coefficients. A new list re-parameterises
  the running node, which keeps its filter and detector state (no click on a
  slider). The export does NOT force the premix: `applyAudioFx` runs before
  any mixing — a clip's segment is decoded up to its atempo, processed and
  becomes a temp WAV at speed 1 (its gain, keys, fades and pan then apply as
  before); a track's segments are summed with `mixInto`, processed and become
  one segment (≈23 MB per minute of timeline per track, in memory: a
  10-minute track mixed in 1.9 s, +250 MB peak). DENOISE is a file: ffmpeg
  `afftdn` over the whole source at a noise floor MEASURED per file (10th
  percentile of 50 ms RMS at 48 kHz, told 6 dB above — at the default −50 a
  −35 dB hiss went through untouched, and `tn=1` measured worse), 24-bit
  FLAC in `cacheDir('denoised')` as `<mediaCacheKey(src, ':dn')>-<nr>.flac`
  (REBUILDABLE, `.part` sidecar, one at a time; `audio:denoise`). The preview
  plays it through the pool's source override (audio-track clips only — a
  video clip's element is its picture), the export's `configureDenoiser` hook
  swaps the segment's path. Analysis mixdowns go through the same muxer, so
  they hear the effects too. Not in the chain: fragment audio. Live (sandbox, dialogue clip with EQ + compressor + denoise
  and a de-esser on its track, capture of the preview's master vs a WAV
  export): 44 windows of 0.2 s, worst 0.45 dB, mean 0.11 dB; a 5.1 source
  preview vs export 0.00 dB. Test: `node scripts/check-audio-fx.mjs`.
- `electron/fragments.ts` — Remotion workspace (`~/kadr-fragments`):
  scaffold, vite dev server (watchdogged), fragment create/delete,
  `remotion render` once per content hash at near-lossless settings
  (PNG frames; vp9+alpha `--crf=12` for transparent, h264 `--crf=15`
  otherwise; cached in `userData/fragment-renders`), offscreen
  pixel-capture windows (created with `enableLargerThanScreen` — some
  window managers/displays clamp hidden windows otherwise). The player
  page syncs to the editor clock by nudging playbackRate, not seek jumps.
  EVERY WORKSPACE TOOL (npm, vite, remotion, tsc) is spawned through
  `electron/toolSpawn.ts`, the one place that knows the platform: on
  Windows `npm`/`npx` are .cmd shims (ENOENT without a shell, and refused
  without one since CVE-2024-27980) and `.bin/*` are sh scripts, so node
  runs each tool's JS entry and npm goes through the shell. The vite
  watchdog (vite dies when Kadr does) is `sh … kill -0` on POSIX and a
  node wrapper polling `process.kill(pid, 0)` on Windows — MSYS `kill -0`
  cannot see Windows pids and killed vite at once; there vite is the
  wrapper's child, so it is stopped with `taskkill /T`. Test:
  `node scripts/check-toolspawn.mjs [workspace]`. The workspace pins
  `overrides: { yauzl: 3.4.0 }` (`WS_OVERRIDES`): remotion unpacks its
  Chrome with extract-zip 2.0.1 over yauzl 2, which on Node ≥ 24.16
  (nodejs/node#63487) stops after a few entries and exits 0 — no browser,
  no video, no error; a Chrome zip still lying next to its folder is such a
  half-unpacked browser and is dropped before a render (`healBrowserCache`).
  Every cache in the app builds into a `<key>.part.<ext>` sidecar and is
  RENAMED on success, so the presence of a cache file always means
  "finished". This matters most for fragment renders: remotion writes its
  output progressively, and a killed render used to leave a truncated file
  exactly where the next export looks for a hit — loud for an opaque
  fragment (an mp4 without its moov box does not probe) but SILENT for a
  transparent one, since a short WebM parses fine and just ends early.
  `sweepPartFiles` drops leftover sidecars at startup: nothing is building
  then, so any that exist are corpses.
  Progress parses both remotion phases, "Rendered N/M" and "Stitched N/M"
  (older versions say "Encoded"), on a bounded tail of the output: the
  second phase used to be invisible, and a heavy transparent fragment sat
  on one number for many minutes. `cancelFragmentRenders` (IPC
  `fragment:cancel-render`, also called on quit and by the export's cancel)
  SIGKILLs a snapshot of the whole process TREE — remotion starts Chrome in
  a process group of its own, and on SIGTERM it launched a fresh Chrome that
  was reparented to init and stayed — then removes the render's
  `react-motion-render*` frame dir. On Windows a render's TEMP is
  `userData/render-tmp`: a hard kill runs no cancel, and it left the frame
  dir, Chrome's profile and the webpack bundle behind; only a folder nobody
  else writes to can be emptied at the next start (`sweepRenderScratch`,
  after the process sweep). Content trap: per-frame random noise
  (film grain) in a transparent fragment makes every PNG and VP9 frame
  incompressible (measured 119 MB / 144 s vs 3.6 MB / 40 s for 120 frames);
  put grain on its own track as a short looped RGBA clip. Speed note:
  remotion stitches with libvpx-vp9 and no speed flags; `-row-mt 1` is ON
  (the managed config, chained after the user's own override via
  ConfigInternals; `KADR_VP9_ROW_MT=0` turns it off). It is NOT
  bit-identical — frames differ from a plain encode at ~54–58 dB — but both
  are equally close to the lossless frames (colour 55.72 vs 55.73 dB, alpha
  62.33 vs 62.34), and the speed-up is content-dependent (10–80 %).
  Preview stacking: fragment iframes sit OVER the GL canvas, so they are
  appended bottom track first, and `fragmentNeedsCapture(track, clip,
  project)` sends a fragment through pixel capture whenever something
  GL-drawn overlaps it in time on a track above — otherwise an opaque
  fragment on a low track hid every ordinary clip over it (the export was
  always right). Hot reload: chokidar does not follow a symlinked folder
  that appears after the dev server started (every fragment created in a
  saved project), so the generated vite config carries
  `followProjectFragments`, which watches the real folders and replays their
  events on the symlinked path — and re-watches a folder deleted and created
  again at the same path (the watch dies with the folder; the inode is not
  a reliable sign — tmpfs reuses it — so it asks chokidar's `getWatched()`).
  The dev server outlives app restarts; when Kadr's vite.config template
  changes, the running server restarts itself, so `ensureServer` waits while
  the port is taken, adopts a server that won the race, and serializes
  starts (probing once used to spawn a second vite that died on «port in
  use»).
  PREVIEW SPEED (a project of eight heavy three.js fragments): each fragment
  page loads ONLY its fragment (`src/fragments/lazy.ts`; the page imported
  the whole registry — every fragment of the workspace — before), runs in a
  process of its own (`f<slot>.localhost`: each is a site, hence a process;
  the lowest free slot, so the incoming and outgoing pages never share a
  main thread), draws its ThreeCanvas on DEMAND at the displayed size (a
  vite-only shim `src/_kadr/three-preview.tsx`; `remotion render` never
  sees it), parks at opacity 0.001 (not visibility:hidden — bringing a
  page back cost ~100–250 ms of nothing), shares one page across butt-joined
  clips that continue each other, and follows the clock through a store
  subscription. Measured: the next fragment's first frame 2.3 s → 42–76 ms,
  a page's heap 380 → 62 MB. Capture windows reconcile one pass at a time
  and close on a reload of the editor page.
  READINESS: `window.__kadrDrawn` is the frame really on the page (no
  pending delayRender, every canvas drew it, two rAFs); the page runs one
  empty delayRender/continueRender pair at boot (`remotion_renderReady`
  stays false otherwise), honours a leaked delayRender for 1.5 s only, and
  the frame a snapshot waits for is clamped to the composition.
  PROJECT LIBRARY: `<project>/kadr-lib` is `'@lib/…'` for every fragment
  of a saved project (vite and webpack resolve by the importer's realpath);
  `'@kadr/runtime'` (fonts, `defineInspect`, `defineParams`) and
  `'@kadr/three'` (the 3D kit) are managed files from
  `electron/fragment-kit/`. Fonts in kadr-lib/fonts are registered by the
  page and the render entry, never by a component. Renders go through ONE
  entry (`src/_entries/current.tsx`, rewritten inside the render queue)
  and one managed `kadr.remotion.config.ts` — webpack names its cache
  after the whole config, and an entry per fragment grew that cache to
  gigabytes. `fragmentHash` walks kadr-lib and `src/_kadr` only when the
  sources import them. The workspace's package.json/tsconfig are merged and
  missing deps installed on start. `kadr_typecheck` checks one fragment.
  PARAMETERS: `defineParams`/`useParams`; the Inspector posts LIVE values to
  every page of the fragment and, after 400 ms of quiet, main MERGES only
  the moved values into `params.json` as it is on disk (an edit by hand in
  between survives); the dev server announces a params.json change from the
  WATCHER (a created file never reaches handleHotUpdate) and pages reload
  the values, not themselves; the render entry imports the file.
- `shared/settings.ts` + `electron/settings.ts` — the settings: one schema
  entry per setting (type, default, range, `restart`, the overriding `env`
  variable, section). Main owns `userData/settings.json`, read BEFORE the
  window exists and holding only the DIFFERENCES from the defaults (a changed
  default reaches everyone who never touched it); a broken file starts the
  editor on defaults with one warning. An env variable wins and is reported
  as the source. The old localStorage keys (`kadr.lang`, `kadr.trackh`,
  `kadr.snapBeats`, `kadr.confirmDelete`, `kadr.previewLimiter`) move over
  once on boot and are removed only after main wrote them — localStorage
  loses writes on a hard kill (seen live), so it is never a second source of
  truth. Layout conveniences (`kadr.tlh`, `kadr.sidew`, …) stay there.
  THE SCREEN is `src/components/SettingsDialog.tsx` (Ctrl+, / the gear; the
  `app.settings` action), landed from canvas D: every row shows its source
  (default / yours / the env variable, which locks it) and a `restart` row
  keeps its launch value (`running`, `snapshot().boot`) until «Перезапустить
  Kadr» (`app.relaunch()` after the unsaved-work question). Main reads the
  store at USE time through `electron/appSettings.ts` (`setting`, `cacheDir`
  for the rebuildable caches, `tempDir`) — module imports run before
  KADR_USER_DATA is applied; `electron/ffmpeg.ts` stays electron-free (node
  checks bundle it) and is handed its binaries by `configureFfmpeg`. The
  renderer reads `setting(key)` from the store. A default transition is
  STAMPED into each new clip (`transitionIn` of duration 0), never read at
  render time, so a project looks the same on every machine.
  Tests: `node scripts/check-settings.mjs`, `check-settings-wiring.mjs` (every
  schema key has a consumer and a row).
- `src/state/store.ts` — zustand store. Undo convention: callers invoke
  `pushHistory(labelKey)` once before a discrete edit; high-level actions
  push their own. `sanitizeProject` heals foreign/script-written projects
  on load (scalar Anims → {value}, broken keyframes dropped, missing
  fields defaulted). File-backed preset stores (pose/fx) via user-store IPC.
  `useSettings` is a MIRROR of main's settings (see `shared/settings.ts`):
  built from a synchronous `settings:get` on boot, every setter sends
  `settings:set`; `effective(key)` gives `{value, source}`.
  `insertClipsFromAssets` lays several assets back-to-back in one undo
  (audio → audio track, AV twins as usual); `removeAssets` drops bin
  entries AND every clip using them (one undo); `setClipSpeed` rescales
  keyframes/fades and takes an optional `start` (left-edge speed drags
  keep the right edge anchored).
  RIPPLE is one primitive, `shiftAfter(p, t, dt, trackIds, skip)` (every
  clip starting at or right of t moves; a clip across t never does): the
  voice-over splice, `closeGapAt`, `closeGaps`, `rippleDelete` (with twins;
  closes only what the clips left EMPTY) and `extractRange` (all unlocked
  tracks, markers follow) go through it; locked tracks are never passed.
  Test: `node scripts/check-ripple.mjs`. `rippleDelete` (spans taken in the
  original positions, overlapping ones on shared tracks merged so a deleted
  pair moves nothing twice), `rippleTrim` (Shift+drag of an edge;
  the in edge keeps its start, the head comes off the source) and the
  `ripple` flag of `insertClipsFromAssets`/`pasteAtPlayhead` (Shift-drop,
  Ctrl+Shift+V: a clip across the point is split) ripple the receiving
  tracks PLUS the tracks of the twins of every clip they move
  (`rippleTracks`) — an image inserted on V1 must still push the A1 halves
  of what follows. A range cut (`liftRange`) splits through `splitClipAt`,
  so both right halves of a pair stay linked. Test:
  `node scripts/check-ripple-trim.mjs`.
  TRIM MODES (`rollEdit`, `slip`, `slide`, `trimToPlayhead` = Q/W) are built
  on `trimInPlace`, whose clamps (source edges, one frame) apply per edge — so
  `settle` first runs the edit on a scratch `cloneProject`, takes the smallest
  distance EVERY edge could go, and only then edits: a roll or slide that hit
  a limit on one side would otherwise open a gap or an overlap at the cut.
  Test: `node scripts/check-trim-modes.mjs`.
  COPYING THE PROJECT IS THE HOT PATH. A project is deep-copied TWICE per
  edit — once by `pushHistory`, once by the mutation itself (33
  `cloneProject` call sites) — so a drag copies it on every pointermove and
  the undo stack retains 50 of them. An asset's `waveform`/`thumbnail`/
  `thumbnailEnd` are almost all of a project's bytes: measured on a real
  78 MB project, the waveforms were 78.1 of it. A full
  `JSON.parse(JSON.stringify())` there took 248 ms — four frames a second
  while dragging a clip — and 50 history entries held 3.82 GB, which is
  exactly where V8 quits: that renderer died three times in one day with
  «OOM error in V8: JavaScript heap out of memory», the last GC line
  reading 3841 MB of 3847.8. `cloneProject` therefore SHARES those three
  fields instead of duplicating them: 0.58 ms and 18 MB for the same fifty
  entries.
  THE INVARIANT IT RESTS ON: nobody mutates a waveform or a thumbnail in
  place. They are written once, wholesale, by the probe in
  `electron/ffmpeg.ts` and only ever read afterwards — those three fields
  are assigned in exactly one file in the whole tree. If that stops being
  true, the sharing has to go with it.
  The copy is built key by key rather than by blanking the blobs and round
  tripping, so the live project is never modified even for an instant, key
  order survives, and the result serializes byte for byte like a plain deep
  copy; values JSON drops (undefined, functions, symbols) are dropped the
  same way, and junk in `assets` falls through to a plain copy. Test: e2e28
  — the sharing, that fifty entries hold one waveform, that undo restores it
  whole, and that a project written to disk AFTER an undo still carries its
  waveforms (a copy that quietly lost one would stay invisible until that
  project was reopened). The two behaviour checks were verified to fail with
  the sharing switched off.
- `shared/keymap.ts` + `src/engine/actions.ts` — the action registry: every
  editor action (id, label, context, default keys; what it does lives in
  actions.ts), and the ONE keydown handler App.tsx installs on the editor
  and the popped-out preview. Keys are physical codes (ru/en alike) and
  MODIFIERS MATCH EXACTLY — the old if/else ignored them, and Ctrl+D, Shift+D
  and Cmd+D deleted clips. The handler skips a key a widget already
  `preventDefault`ed, a text field or contenteditable, the Claude terminal
  (`.xterm`) and an open dialog. The user's rebindings are the DIFF from the
  defaults in `userData/keymap.json` (user-store IPC, atomic); `findConflicts`
  reports one key on two actions in one context. Actions with no key are
  registered too, for the command palette. THE SHORTCUT EDITOR is the
  «Клавиши» section of the settings (`src/components/KeysSection.tsx`):
  while it captures, a window CAPTURE-phase listener takes every key
  (Alt would open the window menu, Escape would close the dialog) and
  `capturedChord` ignores lone modifiers; a key another action holds asks
  inline — replacing takes that one key from it (`bindChord`), never its
  others. Import/Export move the diff file. Test: `node scripts/check-keymap.mjs`.
  THE COMMAND PALETTE (Ctrl+K, `app.palette`; `src/components/CommandPalette.tsx`)
  lists every registered action and finds it by its label in EITHER language
  (`paletteMatch`: word prefix before substring, the current language before
  the other, registry order breaks ties) — so a new action is findable the
  moment it is registered with a label. It is not a Modal but counts for
  `modalsOpen()` (`useCountsAsModal`). A disabled action stays listed with
  its reason (`why` beside `enabled` in actions.ts, `whyOff`); Enter on it
  does nothing. Test: `node scripts/check-palette-match.mjs` (also fails on an
  action without a ru and an en label).
- THE SOURCE VIEWER (L5, `src/engine/source.ts`, `SourceViewer.tsx`,
  `shared/threePoint.ts`, canvas L): a double click in the bin OPENS a file
  there instead of dropping it at the playhead. It shares the preview's slot
  as a tab (or «Рядом», ≥ 900 px) and is laid OVER the programme, whose host
  div never moves for it; a plain `<video>` routed through the master, no
  second GL context. Marks, position and the V/A targets are session VIEW
  state, never in the project or the undo stack; I/O, Space, J/K/L, arrows and
  Home/End act on it while the last click was inside it (`routeSourceKey`).
  `,`/`.` run `threePointEdit`: Insert opens the gap with `openGap`, Overwrite
  LIFTS the span on the target tracks only (`liftRange` with a track set) —
  an overlap would play as a crossfade. One undo step each.
- `src/engine/mediaImport.ts` — every media intake path: `importFiles`
  (probe → bin, deduped by path, optional timeline placement),
  `dropPayload` (reads dataTransfer SYNCHRONOUSLY: files → uri-list /
  x-moz-url / DownloadURL → portal key), `importDrop` (paths → URLs →
  raw blobs), window-level catch-all drop in App.tsx, drop forensics to
  `window.__dragLog` + `userData/drop-log.jsonl`. FOLDERS AND IMAGE
  SEQUENCES (H6): every import goes through `media:scan` — folders are walked
  in MAIN (`electron/mediaScan.ts`; 10 000 files in ~50 ms, the page never
  waits) to known media, and numbered stills are gathered into runs
  (`shared/sequences.ts`). A folder, a run or a skipped file brings up
  `ImportSummary` first (counts, the runs, one fps). A ticked run is built by
  `media:sequence` (image2 → H.264 BT.709 mp4, or VP9+alpha WebM for RGBA;
  EXR through the sRGB curve) into `userData/imported/seq-<hash>-<name>` —
  REFERENCED, since that file IS the asset's path; a rebuildable cache the
  Storage panel may clear would take the clip offline with no way back.
- `src/engine/offline.ts` + `electron/mediaStat.ts` + `shared/relinkMatch.ts`
  — OFFLINE MEDIA: a moved or renamed source used to be a silent black clip
  and an export that failed at the mux. The offline set is RUNTIME ONLY (asset
  ids, never saved), recomputed by one batched `media:stat-many` pass when the
  asset paths change, when a project is opened or restored (which also opens
  the relink dialog if files are missing — the same paths still need a pass),
  and on window focus. Scheduled with setTimeout, NOT rAF: a window behind
  others gets no frames and the pass never ran. Clips are hatched, the bin
  badges the asset, `startExport` refuses naming the files (stat'ed afresh).
  Relink: «Указать файл», or «Искать в папке» — by name, then by size
  (`MediaAsset.size`, from the probe since this change) + duration; a
  candidate must agree with what is known, be the only fit, and one file never
  serves two assets; older assets without a size are found by name only. Each
  file is re-probed (another kind is refused), all applied as ONE undo step.
  Test: `node scripts/check-relink-match.mjs`.
- Clip speed UX (`Timeline.tsx`): Ctrl-drag on either extend grip or
  clip edge = 0.02–100× with ~16 px snapping to round multipliers AND
  neighbouring clip edges/playhead; a cursor-following ×N badge lights up
  when snapped. Preview clamps element playbackRate to Chromium's hard
  [0.0625, 16] range — out-of-range assignment THROWS. AUDIO HAS ONE SPEED
  RULE (`shared/audioSpeed.ts`): inside that same [1/16, 16]× it follows the
  speed exactly (playbackRate; an atempo chain in every mixdown, fed 0.25 s
  of extra source and cut by sample count — atempo keeps its last window and
  a 1/16× chain came out 0.3 s short), outside it the clip is SILENT in the
  preview and the export alike. The export used to clamp atempo to 0.25–8,
  so a 20× clip's sound ran 2.5× past its end. Test:
  `node scripts/check-speed-audio.mjs`.
  SPEED RAMPS (L3, `Clip.speedRamp`, `shared/speedRamp.ts`): the speed as an
  Anim over clip time (absolute speeds; `speed` stays the base the presets are
  drawn from). The source runs at its INTEGRAL — `sourceOffset(clip, rel)`,
  Simpson per key segment (exact for the polynomial easings), and its inverse
  `relAtOffset` — and every consumer goes through them: `clipSourceTime`
  (preview, export frames, the frame signature, the demux reads behind them),
  frame blending (`speedAt`), the preview element's playbackRate every frame,
  markers, voice defects, words, scenes, trims, splits, range lifts and slips.
  Without a ramp it is `rel × speed` to the bit. The export's audio cuts a ramp
  into 0.1 s constant-speed chunks whose ends sit on the curve (one atempo
  each; inside a chunk the sound runs linearly, a few ms off the picture at the
  steepest preset); a chunk outside [1/16, 16]× is silent, as above. The speed
  menu's «Рампа» row (`setSpeedRamp`: up, down, peak 1→4→1, dip 1→¼→1, or off)
  keeps each clip's source span — duration = span / the preset's mean speed —
  and the group a chain, like the speed dial; a speed change scales the ramp's
  values with the base. Paused, the preview reseeks when the element shows
  another SOURCE frame (`offFrame`), not past a flat 40 ms: off 1× the playhead
  samples anywhere in a frame, and the preview sat one frame off the export.
  Not handled: a reversed ramp (the reversed file plays the same curve, not
  its mirror) and ramps on fragment clips (the menu offers none). Test:
  `node scripts/check-speed-ramp.mjs`.
- `src/engine/player.ts` — pure layer/audio queries, `MediaPool`,
  `drawFrame` (shared by preview and export), `Player` (anchored rAF
  clock, ~4 fps idle when paused; the tick is exception-proof — one bad
  frame never kills playback; element resync never reseeks mid-seek and
  aims ahead by 0.08×speed so software decode can't storm).
  The pool keeps elements only for clips around the playhead
  (`clipsAround`: starting within 8 s, ended within 3 s), and `release`
  disconnects an element's WebAudio source and gain (`detachAudio`). It
  used to keep one for every clip ever touched, wired into the graph for
  good: a 19-minute, 1080-audio-clip project ended its playthrough with
  1080 routed sources, a median frame of 23 ms instead of 7, and 33–53
  corrective seeks (each a gap you hear) per 30 s — 169 in all; after: 7,
  pool ≤ 15. `previewPoolStats()`, `audioStats()` (with
  AudioContext.playbackStats) and `silencePreview(on)` on kadrEditor are
  there to measure it; it also carries `fps` and `dropped` (`FrameMeter`: a
  timeline frame whose wall-clock slot passed with no draw, slots offset by
  half a frame so vsync jitter drops nothing), the preview's readout.
  PREVIEW QUALITY SCALES THE BACKING STORE ONLY (`playback.previewQuality`:
  full/½/¼ → `previewPrefs.scale` → `Compositor.scale`): `width`/`height`
  stay the project's and carry all geometry, masks and effect radii; the
  viewport, readback and FBOs use the scaled pixel size. The canvas box on
  screen is CSS, sized from the project (`.preview-canvas-wrap` is a size
  container), so every overlay that follows the canvas rect — fragment
  iframes, the gizmo, the onion skin, the guides — is untouched. Shot mode
  (`setSourceQuality(true)`) draws at scale 1, and the exporter's own
  compositor never leaves it. Test: `node scripts/check-preview-scale.mjs`.
  THE CLOCK HAS A SIGNED RATE (J/K/L, card E5): `advanceClock` in
  `timelineMath.ts` is the whole clock — `t = anchor.t + rate·Δts`, a new
  rate re-anchors like a scrub, a loop (`loop`, Ctrl+L: the range or the
  whole timeline) wraps with the overshoot carried over and re-anchors at
  the wrap, and play in→out (`/`) stops at `playEnd`. A pause resets the
  rate to 1. Forward rates multiply the element `playbackRate` (pitch kept,
  the resync tolerance scales with it; audio past the 16× cap is silent, as
  for a clip that fast). REVERSE HAS NO ELEMENT PATH: elements are handled
  as paused and follow by seeking, muted, with no loading spinner. Fragment
  pages get `rate` in the sync message (the Remotion Player caps at 4×; the
  drift check seeks past that) and `playing: false` in reverse, so they
  follow by seek. Test: `node scripts/check-clock.mjs`.
- `src/components/Timeline.tsx` + `src/engine/timelineMath.ts` — on big
  projects: clips culled to the view ± half a screen (plus the selection)
  once the content is longer than 4 screens; `ClipView` is memo'd and gets
  its visible slice (a constant pair when off screen); a clip under 6 px is
  one element; clip geometry is `calc(var(--z) * N px)` so a zoom is a
  style change, with zoom-dependent decisions following a settled zoom; the
  visible seconds are derived from the scroll PIXELS in render. Zoom
  gestures (wheel, slider) only scale the drawn lanes, ruler and
  `.tl-overlays` about the anchor and commit once the gesture pauses (or
  stretches past 0.5–2×, or on any pointerdown), keeping the anchor time
  across chained commits. Key zooms (Shift+Z fit, Alt+Z the selection, =/-
  about the playhead; `fitZoom` in timelineMath, zoom floor `MIN_ZOOM` 0.25
  px/s so an hour fits) go through `timelineView`, the same commit. The
  playback follow (`playback.follow`: off / page / smooth, `followLeft`)
  scrolls while playing and never during a zoom gesture. Test:
  `node scripts/check-zoom-fit.mjs`. Waveform columns are sliding-window maxima,
  k chosen per pixel — EXACTLY the old full scan (a merged-bin pyramid
  smeared lone clicks and was rejected); overlap zones are one sweep.
  Measured and rejected: CPU rasterisation (faster timeline, worse preview
  and export), software waveform canvases, dropping clip decorations.
  THE LEVEL LINE TAKES POINTS (K1): a clip's rubber band (gain for audio,
  opacity for video) — a click adds a key at the CLIP-LOCAL time under the
  pointer at the level the line had there, a drag of a point moves it between
  its neighbours (Shift: along time only), right-click removes it (the last
  one leaves a flat level at its value), a drag of the line moves every point
  alike; one gesture is one undo step. Points hide under 30 px, like the fade
  handles. The maths is `levelAt`/`addLevelPoint`/`moveLevelPoint`/… in
  `src/components/animUtils.ts`. Test: `node scripts/check-gain-points.mjs`
  (with ffmpeg: a dip drawn on a trimmed clip is mixed where it was drawn).
- `src/gl/compositor.ts` — WebGL2 quad compositor: perspective-correct 3D,
  masks (crop + up to 8 shapes), transition FBOs, motion-blur accumulator,
  glow + gaussian-blur effect passes (`drawLayerFx`), raw-BGRA capture
  upload, packed colour-over-matte sampling for alpha video
  (`LayerDraw.alphaPacked`), and pipelined readback for the export pipe
  (`startRead`/`finishRead` through a pixel-pack buffer). PRIMARIES (J1,
  `Clip.grade`, `shared/colour.ts`): seven Anims — exposure in stops,
  contrast, saturation, temperature, tint, highlights, shadows −1…1 — run in
  the clip shader in LINEAR light on straight colour before opacity, highp;
  the reference maths and the GLSL live in one file. `gradeAt` hands the
  layer its values, or nothing when neutral at that moment: then the shader
  skips the grade, so an ungraded clip is not a single pixel different. The
  grade is optional on the clip (absent = none; a present one is completed by
  `sanitizeProject`), its keys follow trims and speed through `forEachAnim`,
  and a graded fragment goes through pixel capture. A LUT (J2, `Clip.lut`
  {path, intensity: Anim}, `shared/lut.ts`) runs after the grade, still on
  straight colour: a .cube 3D table is a half-float TEXTURE_3D sampled
  trilinearly by the hardware at texel centres, a 1D one an N×1 texture read
  per channel; within 1/255 of ffmpeg's lut3d/lut1d. The file is read once per
  path (`src/engine/lut.ts`): the preview draws without it until it has loaded,
  the export and snapshots await it first. `lutImport` copies a file into
  `<project>/kadr-lib/luts`, and the path is one of the project's
  (`projectPaths` kind `lut`), so it is saved relative and collected.
  BLEND MODES (J3, `Clip.blend`, `shared/blend.ts`): screen, multiply, add,
  overlay, soft light, difference — W3C separable formulas on the encoded
  straight colour (add = min(1, Cb + Cs) through the same formula). A blended
  clip is drawn ALONE into a buffer of its own (effects and frame blending
  included), the destination is blitted into a second one, and one pass mixes
  them (`drawBlended`) — two extra full-frame buffers and a copy per blended
  clip. Normal (or absent, or an unknown value — `blendOf`) never comes there:
  its export frames are byte-identical to before. Inside a transition or an
  edge effect the clip is drawn into an empty overlay, so its mode has nothing
  to mix with and it draws as normal. A blended fragment goes through pixel
  capture.
  KEY (J4, `Clip.key` {mode chroma|luma, colour, tolerance, softness, spill:
  Anim}, `shared/key.ts`): YCbCr BT.709 on the encoded straight colour —
  chroma keys by CbCr distance (ffmpeg chromakey's similarity scale), luma
  by |Y − Y(key)|; alpha ramps from tolerance to tolerance + softness. Spill
  takes out the chroma pointing at the key's hue, luma kept (a fringe goes
  grey; a foreground colour of that hue loses it too). It runs FIRST in the
  clip shader — after an alpha-packed source is unpacked, before the grade —
  and multiplies the source's alpha and the masks'. A keyed fragment goes
  through pixel capture. 4:2:0 footage carries chroma at half resolution, so
  its key edge is two pixels wide and blocky on hard edges: raise softness,
  or key a 4:4:4 source.
  WHEELS AND CURVES (J7, `Clip.wheels` {lift, gamma, gain: {x, y, level}},
  `Clip.curves` {y|r|g|b: [x, y][]}, `shared/curves.ts`) are per-channel
  functions of the encoded colour after the grade, so together they BAKE into
  one 1024-entry 1D half-float table per clip (`curveTable`, cached by
  content — the same settings are the same object, uploaded once; a drag
  makes one per step; `begin` frees any table texture — curve or LUT — no layer
  bound for 8 frames, so a drag or a replaced LUT leaves nothing behind) that the shader
  samples between the grade and the LUT. They are NOT Anims: a keyframed
  wheel would mean a bake per frame. Wheel: out = (gain·(x + lift·(1 − x)))
  ^(2^−gamma), the puck a zero-sum shift along its hue (screen coordinates,
  red at 0°, clockwise). Curve: monotone cubic (Fritsch–Carlson tangents) —
  through every point, no overshoot; (0,0)/(1,1) implied unless a point sits
  at that end; Y first, then the channel. Neutral bakes nothing and the
  shader skips the pass. The table serialises as its key (`toJSON`), a
  parsed .cube as `lut#<n>` (J14):
  `frameSignature` stringifies every layer per motion-blur sub-sample.
  «ДО И ПОСЛЕ» (J6, the colour section's head, Shift+\) is PREVIEW ONLY: the
  player draws the frame, then draws it again with the selected clip's colour
  stripped under a scissor over the left of the divider (`clipLeft`), so
  `drawFrame`, snapshots (`drawNow`) and the export never see it. The key's
  pipette draws that clip ALONE without its colour, reads the 5×5 mean
  (`meanAt`) and draws the preview again in the same task.
  SCOPES (J8, `src/components/ScopesPanel.tsx`, the side panel's «Скопы» tab
  or a window of their own — `scopesPopout`, the same `makePopout` as the
  preview's, one host moved, nothing rebuilt): while a panel is shown
  (`subscribeScopes`) the Player blits each finished frame — BEFORE the «До и
  после» pass, so they show the result — into a 320-wide FBO and reads it into
  a PBO with a fence (`scopeRead`/`scopeFetch`): no stall, fetched a tick
  later. Every draw while paused, ≤ 15 a second while playing; measured on a
  1080p60 clip: no fps change, no dropped frame. `shared/scopes.ts` counts
  them (BT.709 full range: luma 0–255 = 0–100 %, full Cb/Cr at 90 % of the
  radius). They read the GL frame only: a fragment shown as an iframe is not in
  it, and the panel says so.
  `holdSources`
  keeps a dynamic texture from re-uploading once per motion-blur
  sub-sample.
  CONTEXT LIFECYCLE: `dispose()` frees the GL resources and drops the
  context — ONLY for a compositor on a throwaway canvas (the exporter
  builds one per run). A canvas hands out the SAME context object
  forever, so disposing the preview's compositor would black the preview
  out for good; `Player.detach` therefore leaves it alone. `contextLost()`
  exists because a lost context makes every GL call a silent no-op —
  `readPixels` leaves its buffer untouched, so an export would finish
  "successfully" as a black file. The exporter checks per frame and after
  the last one; the preview asks for the context back on
  `webglcontextlost` and rebuilds on `webglcontextrestored`. Two traps
  worth knowing: `getExtension` returns null on a LOST context (take the
  `WEBGL_lose_context` handle while it is alive), and `restoreContext()`
  is ignored when called from inside the lost event — defer it a turn.
  THE CONTEXT IS NOT `desynchronized`, and must not become one again: on
  Windows that flag puts the canvas in front-buffer mode, where the screen
  can catch a frame between `begin()`'s clear and the layers drawn over it.
  Measured on a real edit with a screencast of the composited page, 12 s of
  playback: 131 black frames out of 916 with the flag, 0 out of 645 without
  it. The canvas content was never black in either run — only what reached
  the screen — so this is invisible to anything that reads back pixels. The
  flag buys at most one frame of latency in return.
  The preview's context is `alpha: true` (H2): an opaque background clears
  to alpha 1 and the blend keeps it there, so nothing changes on screen; a
  `'transparent'` one shows the CSS checkerboard under `.preview-gl`.
- `src/gl/transitions.ts` / `src/gl/edges.ts` / `src/gl/glow.ts` — GLSL
  registries: 14 overlap transitions, 12 edge (tip) transitions, the smoky
  outer-glow effect.
- `src/engine/exporter.ts` — offline render: fragment materialization →
  fast decode (`src/engine/demux.ts`, mp4box + WebCodecs, element-seek
  fallback, `KADR_DISABLE_FAST_DECODE` kill-switch) → optional 8-sample
  motion blur and per-clip frame blending → ffmpeg x264 encode at the
  preset bitrate, or in the quality mode at CRF (default 18) — both with a
  chosen x264 speed, args built in `shared/rawEncode.ts` (ABR args
  unchanged, test `check-rate-control.mjs`) and written to the session
  log on every export; H.264 may instead run on a HARDWARE encoder
  (`export.videoEncoder`: nvenc / qsv / amf, `rawCodec`), each with its own
  ABR and constant-quality («CQ», not CRF) args. `detectEncoders` in
  electron/ffmpeg.ts trusts a one-frame test encode, not the `-encoders`
  listing (a listed encoder with no driver fails only at encode time); once
  per launch, in parallel. One chosen elsewhere that does not open here
  encodes on x264 with a warning. Test `check-encoders.mjs`.
  CODECS AND ALPHA (G6, `VIDEO_CODECS` in shared/rawEncode.ts): the dialog's
  codec (`export.codec`, laid over the preset by `withCodec` — container and
  audio follow it) is H.264, HEVC (libx265 or `hevc_<gpu>`, tagged hvc1),
  AV1 (SVT-AV1, else libaom, or `av1_<gpu>`), VP9, ProRes 422 HQ / 4444
  (prores_ks, .mov, PCM audio) or a PNG sequence (`name_000001.png`, written
  straight to its folder, no audio, no mux). `pickEncoder` decides per
  machine: libx265/SVT/libaom are detected like the GPU encoders, since the
  gyan.dev essentials build has no SVT. Anything but H.264 takes the raw
  path (Chromium's fast encoder writes H.264 only), and the raw temp file is
  a container that holds the codec (`rawTempExt`: mov/webm/mp4). VP9 and AV1
  count quality 0–63, the rest 0–51. A project background of `'transparent'`
  (the Inspector's «Прозрачный», H2) on an alpha codec builds the export compositor
  with `alpha: true` and clears to (0,0,0,0); the drawing buffer is then
  PREMULTIPLIED (the blend is SRC_ALPHA over the clear), so the raw args
  unpremultiply in planar RGB (`format=gbrap,unpremultiply=inplace=1`) before
  `yuva444p10le` / `yuva420p` / `rgba` — fed as straight alpha, every
  antialiased edge would go grey. ffmpeg 8+ tags frames with an alpha mode and
  its unpremultiply passes an untagged frame (rawvideo is one) through
  UNTOUCHED, so the chain names `setparams=alpha_mode=premultiplied` first —
  only where `-h filter=setparams` lists that option (K11: older builds refuse
  it), asked once per binary by the preload and by `RawVideoEncoder`. VP9's alpha is a lossy stream of its own:
  expect a faint black halo at alpha < 25 % (≤ 7/255 over mid-grey
  measured); ProRes 4444 and PNG are clean. A size other than the project's is fit (bars), fill
  (crop) or stretch (`ExportPreset.fit`, `outputRect` for the fast
  encoder's blit), and frames are sampled at the OUTPUT fps (the preload spawns ffmpeg and receives readPixels
  frames BY REFERENCE — contextIsolation is off exactly for this; every
  IPC/bridge route copies ~8 MB per 1080p frame and tripled render time;
  Chromium's own WebCodecs encoder ignores the requested bitrate and
  stays behind the «fast encoder» checkbox) → main-process ffmpeg mux
  pass. `src/engine/reverse.ts` — clip reversal flow (cached backwards
  renders, linked AV pairs, ⏳ progress).
  DECODE SPEED is the whole game here: an element seek costs ~0.2 s per
  frame, so everything that can avoid it does.
  * ALPHA VIDEO (VP9+alpha WebM — every transparent fragment render —
    ProRes 4444, HEVC-alpha) has no WebCodecs path in any browser, so
    `alphaPackedFallback` builds a cached LOSSLESS H.264 mp4 that stacks
    the colour frame over its alpha matte (`packHeight`: each half padded
    with repeated edge rows) and the shader splits it apart again. J12:
    the picture is copied VERBATIM (swscale never converts a matrix
    yuv→yuv — the «normalised to BT.709» once written here never happened)
    and the pack is FULLY TAGGED in the space the element shows the source
    in (untagged VP9 → BT.601), so WebCodecs decodes it like the preview;
    the untagged pack came out BT.709 whatever the source. The matte goes
    to limited range ONCE, on the gray plane: ffmpeg 7 compressed it twice
    (opaque 217, exports 0.92× dark). The gaps stop the upload's chroma
    upsampling bleeding across the seam and from the decoder's padding into
    the alpha. Measured (Chromium 148): a BT.601 pack is pixel-identical to
    the preview but for the last column, where the preview's own VP9
    element is off from ffmpeg's decode (0,255,172 for ffmpeg's 1,255,255 —
    a KNOWN LIMIT: the export matches ffmpeg, and parity there would mean
    copying the element's error); a BT.709 one is within 2/255
    (45 dB). `KADR_DISABLE_ALPHA_PACK` forces the old path. Test:
    `node scripts/check-alpha-export.mjs`.
  * THE YUV MATRIX FOLLOWS THE ELEMENT (J9, `shared/streamColour.ts`):
    WebCodecs decodes every H.264/HEVC stream not FULLY described (primaries,
    transfer AND matrix) as BT.709 and fills `VideoFrame.colorSpace` with
    that guess, while `<video>` guesses by height (under 720 → BT.601) and
    also reads the `colr` box. An untagged or matrix-only SD clip exported
    up to 41/255 off the preview (24 dB). `Mp4FrameSource` now decides from
    the STREAM — the SPS VUI (parsed from avcC) and `colr` — and re-wraps
    by the element's rule; a fully described SPS is left to the decoder,
    which both obey. Measured on 26 media rows (Chromium 148, Windows):
    every H.264 row, SD and HD, untagged / matrix-only / full / colr-only /
    VUI-only, is pixel-identical preview vs export. Test:
    `node scripts/check-stream-colour.mjs` (ffmpeg).
  * EVERY SAMPLE IS FED ONCE (J10): after `jump()` mp4box re-extracts the
    samples it still holds AND extracts them again from the re-pump. When
    init's head pump had swept a small faststart file before
    `isConfigSupported` answered, the decoder got I0…P20 then I0 again; the
    IDR bumped P20 out ahead of its B-frames and frames 17–19 exported as
    frame 20 — in some runs only (H8: 3 of 6). `ingestSamples` drops any
    sample number not above the last one queued since the jump. Measured:
    10 exports of a reversed + frame-run project, frame hashes identical
    (before: frame 9 differed in 3 of 4), stage times unchanged. NOR
    ANYTHING BEFORE THE KEY FRAME THE JUMP SOUGHT (J13): mp4box hands out
    the batch it was still filling (30 at a time, cut short by data not yet
    appended) AHEAD of the sought samples, so `jump()` records the seek's
    sample and `ingestSamples` starts there (a seek past the video track's
    end is clamped to its last sample: mp4box would leave nextSample
    stale and the source threw «no frames»). From a delta the decoder threw
    «a key frame is required» and a small faststart file (an SD alpha pack)
    fell back to element seeks in 16 of 20 exports; from a key, the GOPs up
    to it were skipped without a word. After: 80 of 80 on the fast path. Test:
    `node scripts/check-decode-determinism.mjs`.
  * MOOV AT THE END (any file not written with faststart) is picked up by
    fetching the file's tail (`pumpTail`) instead of dropping to element
    seeks.
  * A STATIC SHUTTER collapses: `frameSignature` records what drawFrame
    would draw without touching the GPU, and when every motion-blur
    sub-sample matches, one draw stands in for eight — exact, and
    `KADR_FORCE_FULL_SHUTTER` restores the full pass.
  * Frame blending is skipped for alpha sources: compositing B over A
    reproduces lerp(A,B,w) only while the layer is opaque.
  * `rawEncodeFrame` resolves on stdin's WRITE CALLBACK — `write()`
    returning true only means "keep writing" while the chunk may still
    point at the buffer the exporter is about to refill (torn frames).
  * ffmpeg leaves x264's b_deterministic off, so two identical runs never
    produce identical files: verify picture changes by hashing rendered
    frames (`globalThis.KADR_FRAME_HASH = []`), never by comparing output.
  * The raw-frame ring is TWO buffers by measurement, not by default. The
    loop does spend a few ms per frame waiting there, but the pipe is
    drained by libuv on the same thread, so a deeper ring adds no
    concurrency, only working set: 1080p60, alternating rounds, 2 slots
    50.5 fps / 3 slots 45.7 / 4 slots 45.3, pixels identical at every depth.
  WHERE AN EXPORT'S TIME GOES, so the next person profiling does not repeat
  the dead ends. Every run prints `[kadr] export stage ms/frame`; on a real
  1080p60 project it reads roughly prepare 0.3 · draw 1.7 · read 9.4 ·
  encode 6.2, i.e. most of the time is the frame LEAVING the renderer, not
  compositing or decoding. Two traps: `read` is TRANSFER, not a wait on the
  GPU (a `gl.finish()` after the draw moves nothing between the laps), and
  it is contention-sensitive — the same 8.3 MB measured 3.3 ms on an idle
  machine and 9.4 ms on a busy one, so profile idle or you will chase a
  ghost. The one real lever left is that ffmpeg receives RGBA and converts
  it to yuv420p itself, which costs it more than the encode: measured
  ceilings on identical frames are 89.5 fps for what ships, 121.5 from
  yuv444p and 181.8 from yuv420p, and converting on the GPU would cut the
  readback to 3.1 MB as well — worth roughly 2×. It is NOT done because it
  cannot yet be made bit-exact, and exports must not change a pixel.
  swscale's path is understood — textbook BT.709 limited matrix (exact on
  uniform fields), a plain horizontal pair average, and an 8-tap vertical
  chroma filter (-2,-6,16,56,56,16,-6,-2)/128 summing to exactly 1 — which
  gets a float model within ONE unit of 255 on 0.05% of luma and ~1.4% of
  chroma samples (whole-frame PSNR 71.3 dB), but the last unit is
  swscale's internal fixed-point rounding and no one- or two-stage integer
  model reproduced it, for 4:2:0 or 4:4:4. Implement it from libswscale's
  source, not by measurement. NVENC does not move this much: on an RTX 4090,
  10 s from the app, 1080p60 x264 128 fps vs NVENC 137 (encode stage 2.6 →
  2.2 ms/frame, read 2.4 either way), 2160p60 47 vs 55 fps (encode 7.8 →
  6.2, read 10.2 → 8.5), while the encoders alone on the same frames in
  plain ffmpeg differ by 30–60 %: the frame leaving the renderer still
  dominates. What NVENC buys is mostly a free CPU. Also: `-sws_flags` on the command line does
  NOT reach this conversion (the scale filter's own `flags` default wins),
  so an A/B on those flags that compares output bytes proves nothing, and
  filter threading is already on by default.
  ONE EXPORT AT A TIME: the preload's raw encoder is a single global ffmpeg
  and main's export state and the fragment render queue are shared, so an
  export started while another ran (a script's `startExport` plus the
  dialog's) fed its frames into the other's encoder — both died at 100 %
  («write after end» / «write ECANCELED»), and the second one looked frozen
  until then. `startExport` refuses while `activity.exporting` is set.
- `src/engine/subtitles.ts` / `captions.ts` — SRT parse/serialize,
  word-precise cue splitting (`segmentsToRichCues`), auto-captions
  fragment generator.
- `src/engine/fragments.ts` / `fragmentCapture.ts` — fragment create and
  delete flows (`deleteFragment` removes the clips referencing it too)
  and the hybrid preview: iframe overlay by default, automatic pixel
  capture when the clip carries GL-only features (effects/3D/masks/
  transitions).
- RHYTHM (`shared/rhythm.ts`, on top of the librosa port): the meter and the
  "one" (kick + bass + harmonic change − backbeat snare), sections from
  self-similarity plus loudness jumps, pauses as relative dips that do not
  repeat every bar, the kick offset. Markers `kind: 'beat'|'section'|'pause'`;
  bakes take bars and sections from a 60 s context and give fragments
  `useAccent/accentAt/breathAt/sectionAt/bars/pauses`.
- CHECKS (`src/engine/checks.ts`, «Проверка», `kadr_check`): fragments
  declare `inspect` (events, texts, camera, continuous); a hidden `?inspect=1`
  page samples it at 30 Hz. Thresholds are named constants (`CHECK_LIMITS`);
  camera jerks are speed STEPS against the local peak (raw acceleration
  flagged accepted cameras) on samples kept to 1e-6. Contrast and seams read
  real pixels; collisions play the fragment frame by frame (`?collide=1`)
  and test the kit's parts with three-mesh-bvh (both geometries need an
  index).
- 3D (`electron/models.ts` → `kadr-lib/models`): STL, 3MF (build items,
  components in other package files, units — without them a 150 mm part
  came out 2 mm), OBJ, glTF, STEP via occt-import-js; Z-up → Y-up, welding,
  meshoptimizer decimation, an OBB per part, GLB in metres, a thumbnail
  drawn in software. The kit's `useModel` takes one delayRender per model,
  tied to the load.
- HDR AND ROTATION (`shared/hdr.ts` + `electron/hdr.ts`): a 33³ LUT between
  two swscale matrix conversions (no zscale in older ffmpeg): the transfer's
  inverse and OOTF, an extended-Reinhard shoulder with a 1000-nit peak at 1,
  BT.2020 → BT.709 towards the colour's own luminance (keeps the hue), BT.709
  OETF. Two faults `check-hdr` found in the first curve: an exponential
  shoulder that flattened every highlight above 1.3× reference white, and the
  shoulder applied before the primaries (warm colours clipped towards
  yellow). `HDR_VERSION` is in the LUT name and every tone-mapped cache key.
  Rotated or HDR sources reach the export through an ffmpeg intermediate,
  decided BEFORE the fast decode path.
- `electron/gpu.ts` — which GPU Chromium renders on (auto / discrete /
  integrated, a row in the session log). The EGL vendor variable must be in
  the environment before Electron starts (the GPU process forks from the
  zygote). On a hybrid laptop the discrete card measured SLOWER for the
  preview (every frame is copied to the integrated card to be shown), so
  'auto' keeps the default.
- The onion skin (`src/engine/onion.ts`, `OnionSkin.tsx`): a footage clip as
  a `<video>` over the preview, translucent or in difference mode, never in
  snapshots or exports; selecting a fragment (to drag its sliders) does not
  steal it.
- `src/engine/autosave.ts` + `electron/backups.ts` + `shared/backups.ts` —
  autosave every 5 minutes and after 25 history moves, skipped while an
  export or the voice-over check runs (`activity` flags). NOT during a Claude
  session: every edit replaces the project object, so a tick never sees half
  of one. Each tick writes a VERSION to
  `userData/backups/<projectKey(path) | unsaved-<id>>/<ISO time>.kadr`
  (+ `source.json` naming the project file) — newest 10, at most 500 MB per
  project, the newest always kept — and `<name>.autosave.kadr` next to a
  saved project (never-saved ones no longer land in Downloads).
  `session.lock` is written at startup and removed in window-all-closed; a
  lock found at the next start means Kadr died, and the page is offered the
  newest backup WRITTEN DURING THAT SESSION and newer than its project file
  (Restore opens it as an unsaved copy). Only that session's backups: an
  older one was there to offer before, and would come back after every kill.
  The offer is handed out once per launch, so the page memoizes its ask
  (StrictMode's double effect otherwise answered null over it). Opening a
  project sweeps `<path>.part-<pid>` sidecars of dead writers left by a
  crash mid-save. Test: `node scripts/check-backups.mjs`.
- `src/engine/chime.ts` — short WebAudio two-note signal when a render
  finishes (wired to export progress in `src/main.tsx`).
- Timeline markers live in `project.markers` (`addMarker`/`moveMarker`/
  `removeMarker`/`updateMarker` in the store, flags drawn by `Timeline.tsx`,
  M key in the action registry): project-wide time labels, not bound to a track, and
  part of `kadr_state` so the embedded Claude can read and place them. L1: a
  marker carries an optional `note` and `color` (a label index, like a clip's);
  CLIP MARKERS (`Clip.markers`, `addClipMarker` — the clip menu, Alt+M) are
  stored at their SOURCE second, like the voice defects, so a move, trim, slip,
  speed change or split never has to touch them; `shared/markers.ts` places
  them (hidden when trimmed off), lists them with the user's own markers for the
  side panel's «Маркеры» tab (`MarkersList.tsx`: click to jump, name and note
  edited in place) and serves Shift+M / Ctrl+Shift+M (`goToMarker`).
  Test: `node scripts/check-markers.mjs`.
  NEITHER A MARKER NOR A TRACK OF CLIPS GOES ON ONE CLICK: a marker's right-click
  opens Rename / Delete, and «Удалить дорожку» on a track with clips asks
  first (`trackDeleteAsks` in `discardGuard.ts`; `useSettings.confirmDelete`,
  default on, turns the question off). Each stays one undo step. Test:
  `node scripts/check-destructive-confirm.mjs`.
- `electron/tts.ts` + `src/engine/tts.ts` + `shared/ttsText.ts` — ElevenLabs
  voice-over. THE KEY NEVER REACHES THE RENDERER: the page is scriptable
  (`kadr_eval`), so the key lives in `<userData>/elevenlabs-key.json`,
  written 0600 on the `open()` rather than chmod'ed afterwards, and the
  page can only set it or ask whether one exists. `TtsParams` has no key
  field. Long text is cut at the strongest available boundary (paragraph →
  sentence → clause → space) under the model's cap and stitched with
  previous_text/next_text plus previous_request_ids; the pieces rejoin to
  the input BYTE FOR BYTE, because the defect detector addresses the
  script by character offset and one lost space would shift every later
  index. The optional speed-up rides the same ffmpeg pass as the decode
  and is stored on the run, never re-read from the current settings — a
  regenerated phrase must be sped up like the file it goes into. Output is
  FLAC in the source's own channel layout: forcing stereo duplicated the
  channel and cost exactly 3.01 dB through ffmpeg's downmix matrix.
  `KADR_TTS_MOCK=1` synthesises speech-shaped audio locally so tests never
  spend credits.
- `shared/proxy.ts` — which proxy the API calls use, and how to spell it
  for Chromium (`https=host:port;http=host:port`, or a full `socks5://`).
  `net.fetch` always uses the DEFAULT session, whose proxy Chromium picks
  by itself and may well settle on HTTP_PROXY when only HTTPS_PROXY can
  reach the API — the proxy's own error PAGE then arrives where JSON was
  expected («Unexpected token '<'»). The module owns a partitioned session
  and sets the proxy explicitly. Node's fetch is not an option: it ignores
  proxy environment variables entirely. Test: `node scripts/check-proxy.mjs`.
- `electron/voice.ts` + `python/ttsqc` + `scripts/ttsqc_run.py` — the
  voice-over defect detector, vendored with its light weights. Findings
  land in `Project.defects`, runs in `Project.voiceRuns`; TIMES ARE SOURCE
  SECONDS AND THE RECORD BINDS TO `assetId`, not to a clip — clips are
  moved, trimmed, split and rippled, so a timeline number would be stale
  after the first edit, while a source number only goes wrong when the
  FILE changes, which is exactly what invalidates the finding anyway.
  Phrase boundaries are computed in `python/kadr_phrases.py` (pure
  numbers, testable on synthetic audio via `scripts/check-phrases.py`):
  the cut is the middle of the LONGEST REAL SILENCE in the gap between
  sentences, found from Silero speech probabilities refined by 5 ms RMS.
  THE DRIVERS SAY NO WORDS (I12): `ttsqc_run.py` and `transcribe.py` put a
  failure on their last stderr line, a self-test problem and a learn
  `problem` in their JSON, as `said(key, args)` — the shape of
  `shared/said.ts`, ASCII JSON — and the renderer says it in the UI language;
  argparse's own complaint goes the same way (exit 2). Main spawns them with
  `PYTHONIOENCODING=utf-8`: on Windows python writes the ANSI code page into
  a pipe, and every Cyrillic word of a transcript or a defect arrived as
  U+FFFD. The vendored `python/ttsqc` keeps its Russian console CLI.
- `src/engine/voiceRegen.ts` + `shared/voiceMap.ts` — regeneration.
  EVERYTHING CONFIRMED ON ONE VOICE-OVER IS DONE IN ONE PASS: doing them
  one at a time would mean recomputing every later cut inside an
  already-shifted file. The patch is synthesised from the exact script
  substring with surrounding context, sped up by the RUN's factor, matched
  to the level and edge silence of what it replaces, and spliced with
  `acrossfade=c1=qsin:c2=qsin` (a linear fade dips 3 dB mid-speech). The
  new length is MEASURED with probeMedia, never computed, and everything
  to the right shifts on all unlocked tracks. A clip whose EDGE falls
  inside a replaced phrase is refused by name instead of being guessed at.
  `voice:reindex` carries the analysis over the splice, because the index
  describes the file as it was analysed and every splice rewrites it.
- `src/engine/voiceLearn.ts` — verdicts go to the run's own corpus in the
  detector's format. HAND-PLACED MARKS GO IN A SEPARATE FILE: a verdict
  row matching no candidate lowers the match count, and once such rows are
  more than half the file the WHOLE file is discarded, real labels
  included. Retraining is never automatic — it rebuilds from scratch, so
  the previous model is copied aside first, cross-validation numbers are
  printed, and it refuses below 30 examples across ≥2 files.
- `src/styles.css` — THE design system, and the only place a colour, a
  size, a radius or a duration may be born: `:root` holds the neutral ramp
  and accent, the same colours as channels for washes, and the editing
  colours that are part of the model rather than decoration. Nothing below
  `:root` carries a literal colour — a grep for `#` outside the token
  block must come back empty. Contrast is MEASURED against WCAG 2.2 AA.
  SCROLLBARS are a trap: Chromium's standard properties and the
  `::-webkit-scrollbar` pseudo-elements are mutually exclusive — set
  `scrollbar-width` to anything but `auto` and every pseudo-element rule
  is dropped silently, and only the pseudo-element path can set a MINIMUM
  thumb size, which the timeline needs (its thumb is proportional to the
  zoom and degenerates to under a pixel at high zoom).
- `src/components/icons.tsx` — the icon set: lucide (ISC) inlined as SVG,
  no dependency and no network. GENERATED by `scripts/gen-icons.mjs`; add
  a glyph by adding a line to its MAP, never by hand-editing the paths.
  Emoji used to do this job and are banned from the interface: their
  shape, weight and colour come from whatever font the OS ships.
- `src/components/Modal.tsx` — the one shell all dialogs use: titled head,
  scrolling body, fixed footer, `role="dialog"`, Escape, a real focus trap
  and focus restored. It also exports `modalsOpen()`, which App.tsx checks
  before acting on a global shortcut — Space on a focused dialog button
  used to press the button AND start playback behind it.
  The backdrop sits above the floating panels (z-index 70 over their
  55–60): a dialog opened with the Claude panel up had its buttons under it.
- `src/engine/log.ts` + `src/components/DebugPanel.tsx` — the session log.
  Twenty places reported failures with `console.warn` and nothing else, so
  a snapshot that did not happen and an import that brought nothing in
  both looked like "I clicked and nothing happened". IN MEMORY ONLY: a
  ring of 500 entries that dies with the window. The button is silent
  until something fails; INFO never raises it, and benign browser notices
  (`ResizeObserver loop …`) are recorded as INFO rather than as failures.
- `electron/storage.ts` + `electron/cacheKeys.ts` + `StoragePanel.tsx` —
  what the editor has left on disk. The split that governs everything is
  REBUILDABLE vs REFERENCED: a proxy, a decoded intermediate and a
  fragment render are named after their source (a hash of path+size+mtime),
  so deleting one costs time and nothing else; a reversed clip, a download
  and a voice-over run are stored BY PATH in the project and cannot be
  derived again. RELATIVE PATHS AND COLLECT (H8, `shared/projectPaths.ts`,
  `electron/collect.ts`): in memory every path is absolute; `project:write`
  stores a path lying inside the project's folder relative to it (always
  '/'), `project:read` (and the Storage scan) resolves it again, so autosaves
  and backups keep absolute ones. «Собрать проект…» (the ▾ on «Сохранить
  как…», action `file.collect`) copies every referenced file — not proxies —
  into `<project>/media/` through `.part` sidecars, reuses a same-named file of
  the same size already there, rewrites the paths in one undo step and saves.
  A collected file has a new path, so its proxy key changes and the proxy is
  rebuilt on the next machine — accepted; backups are REFERENCED too (user data), one folder per
  project named `projectKey(path)`. Project templates (`userData/templates/
  <name>.kadr`, H3) belong to no project and are never deleted from the panel. The key formula lives in its own file because a second
  copy would drift, and a drifted formula aims a delete button at the
  wrong file. Projects are keyed BY PATH, never by name. `storage:prune`
  FAILS CLOSED: without an explicit `confirm: true` it only counts, so a
  caller newer than the handler errs towards keeping the files.
- `src/engine/popout.ts` — the preview (and, J8, the scopes; K12, the
  mixer) in an OS window of its own, one `makePopout()` each. NOTHING
  IS REBUILT ON THE WAY OVER: the preview always lives in ONE host div
  that a React portal renders into, and popping out only moves that div
  into the popup's document — re-creating it would mean a fresh GL context
  every toggle (Chromium keeps 16 per renderer and force-loses the oldest)
  and a reload of every fragment iframe. The popup is `about:blank` opened
  with `window.open`: same origin and same renderer process, which is the
  only reason the live canvas can be adopted. THE CLOCK AND THE OBSERVERS
  FOLLOW THE CANVAS, not the window they were born in — the rAF loop
  re-reads `canvas.ownerDocument.defaultView` every frame, and the
  ResizeObservers in the moved subtree are rebuilt in the new window (an
  observer belongs to the document it was created in and delivers NOTHING
  for an element in another one). Rule of thumb for anything added inside
  the preview: if it says `window.`, ask which window.
- `window.kadrEditor` (set in `src/main.tsx`) — scripting surface for
  automation / AI / MCP integration.

## Testing
`scripts/e2e*.mjs` drive the app over CDP. Async evals park results in
globals and poll (`awaitPromise` is flaky under GC). Tests autosave any
non-empty live project before reloading the page, and back up/restore
`claude-env.json` when they override the Claude command.

A suite that touches a user store MUST snapshot and restore it: the
preset stores, the Claude command override, the voice-over settings and
the ElevenLabs key are all real user data shared with real sessions, and
each of them has been destroyed by a test at least once.

## Conventions
- All timeline math in seconds; keyframe times are clip-local. Every store
  edit (split, trim, move, insert, paste, speed/duration, range edges,
  markers) lands starts and ends on frame boundaries (`toFrame` in
  `timelineMath.ts`; 29.97 is 30000/1001) — the speed and the in-point are
  never quantised, and loading never requantises an old project. Test:
  `node scripts/check-frame-quant.mjs`.
- Profiling over CDP: sample at ≥ 1 ms and never kill the profiling client
  mid-run. A 200 µs profile whose client died left V8's sampler signalling
  the main thread, and a large shared-memory allocation (a project with its
  waveforms, sent to main for an autosave) was interrupted and restarted
  forever — the editor froze in one syscall. Frame timing needs no profiler.
- Mutations never auto-push history; see the store convention above.
- `electron-vite dev` does NOT hot-restart the main process — main/preload
  edits need a full app restart.
