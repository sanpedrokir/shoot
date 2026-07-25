// A procedurally synthesized "orchestra-rock" hybrid score — no audio file
// or sample library needed, everything is generated in-browser with the Web
// Audio API.
//
// It's a real (short) song, not one bar on a loop: four 4-bar sections with
// their own riff, chord, and drum feel (two verse sections, then two
// heavier chorus sections with a thicker/more distorted guitar and a
// double-kick pattern), each capped with a busier turnaround fill on its
// last bar, before the whole 16-bar arrangement repeats. Four layers make up
// the mix at any moment:
//   - A distorted guitar riff (the "rock" backbone; each section has its
//     own note pattern and rests, not just one repeating chord).
//   - A slow-swelling string-section pad underneath (many detuned
//     oscillators per note — the classic trick for turning a single
//     synth voice into something that reads as an ensemble rather than one
//     buzzy tone), changing chord once per section.
//   - Short brass-like stabs accenting each section change (the "orchestra
//     hit" you'd hear in a trailer score).
//   - A drum layer (kick, snare, hi-hat) built from filtered noise bursts
//     and a pitched sine thump, sparser in verses and four-on-the-floor in
//     choruses.
// A convolution reverb send glues all four together with a sense of room,
// and a compressor on the master bus keeps the mix from clipping as layers
// stack — both of which do more for "sounding less synthetic" than any
// single voice's timbre does. Notes are scheduled sample-accurately ahead of
// time (the standard Web Audio "lookahead scheduler" pattern) so timing
// stays tight regardless of setInterval jitter.

const TEMPO_BPM = 156;
const BEAT_SECONDS = 60 / TEMPO_BPM;
const STEP_SECONDS = BEAT_SECONDS / 2; // eighth notes
const STEPS_PER_BAR = 8;
const BARS_PER_SECTION = 4;
const STEPS_PER_SECTION = STEPS_PER_BAR * BARS_PER_SECTION;
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_SECONDS = 0.12;

// Guitar-register note frequencies. `null` in a riff means a rest (a
// palm-muted silence), which is what gives a riff its gallop/syncopation
// instead of reading as a flat wall of eighth notes.
const D2 = 73.42;
const E2 = 82.41;
const G2 = 98.0;
const A2 = 110.0;
const B2 = 123.47;

const RIFF_VERSE_A: (number | null)[] = [E2, E2, null, E2, G2, E2, null, E2];
const RIFF_VERSE_B: (number | null)[] = [E2, E2, G2, E2, A2, G2, E2, null];
const RIFF_CHORUS_A: (number | null)[] = [E2, G2, E2, A2, B2, A2, G2, E2];
const RIFF_CHORUS_B: (number | null)[] = [A2, A2, G2, E2, D2, E2, G2, A2];
// A busier fill on the last bar of every section, cueing that something's
// about to change instead of just cutting straight to the next section.
const RIFF_TURNAROUND: (number | null)[] = [E2, G2, A2, B2, A2, G2, E2, D2];

// String-pad chord roots, one per section, voiced an octave above the
// guitar so the layers don't collide — the same i-VI-III-VII "epic"
// progression as before, but now each chord gets its own riff and its own
// drum intensity instead of the whole song being one bar on a loop.
const E3 = 164.81;
const C3 = 130.81;
const G3 = 196.0;
const D3 = 146.83;

interface Section {
  riff: (number | null)[];
  pad: number;
  // Chorus sections: thicker/more distorted guitar (extra sub-octave
  // doubling) and a four-on-the-floor double-kick pattern instead of the
  // verse's sparser backbeat.
  heavy: boolean;
}

const SONG: Section[] = [
  { riff: RIFF_VERSE_A, pad: E3, heavy: false },
  { riff: RIFF_VERSE_B, pad: C3, heavy: false },
  { riff: RIFF_CHORUS_A, pad: G3, heavy: true },
  { riff: RIFF_CHORUS_B, pad: D3, heavy: true },
];
const STEPS_PER_SONG = STEPS_PER_SECTION * SONG.length;

function makeDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const samples = 44100;
  const curve = new Float32Array(new ArrayBuffer(samples * 4));
  const k = amount;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

// An algorithmic reverb impulse (exponentially decaying filtered noise)
// rather than a recorded impulse response file — enough to give the mix a
// sense of room without shipping an audio asset.
function createReverbImpulse(ctx: AudioContext, seconds = 2.2, decay = 2.6): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * seconds);
  const impulse = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return impulse;
}

function createNoiseBuffer(ctx: AudioContext, seconds = 1): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

export interface RiffPlayer {
  // Creates/resumes the AudioContext without starting the riff loop. Browsers
  // require a user gesture before audio can play; calling this from every
  // early click (join room, invite ally) means the context is already
  // running by the time an ally's game actually starts from a network event
  // rather than a click, which start() alone couldn't do.
  unlock(): void;
  start(): void;
  stop(): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}

export function createRiffPlayer(): RiffPlayer {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let reverbSend: GainNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;
  let timerId: ReturnType<typeof setInterval> | null = null;
  let nextStepTime = 0;
  let stepIndex = 0;
  let running = false;
  let muted = false;

  function ensureContext() {
    if (ctx) return;
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC();

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 18;
    compressor.ratio.value = 3.5;
    compressor.attack.value = 0.006;
    compressor.release.value = 0.18;
    compressor.connect(ctx.destination);

    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.16;
    master.connect(compressor);

    const convolver = ctx.createConvolver();
    convolver.buffer = createReverbImpulse(ctx);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.55;
    convolver.connect(reverbReturn);
    reverbReturn.connect(master);

    reverbSend = ctx.createGain();
    reverbSend.gain.value = 1;
    reverbSend.connect(convolver);

    noiseBuffer = createNoiseBuffer(ctx, 1);
  }

  // Distorted rhythm guitar — a triangle blended in with the sawtooth (pure
  // saw reads as "chiptune"; the triangle rounds off the edge) and a couple
  // of cents of per-oscillator detune, the same trick real amp-sim plugins
  // use to avoid a too-perfect digital lock.
  function playGuitarChord(time: number, freq: number, accent: boolean, heavy: boolean) {
    if (!ctx || !master || !reverbSend) return;
    const dist = ctx.createWaveShaper();
    dist.curve = makeDistortionCurve(heavy ? 34 : 24);
    dist.oversample = "4x";

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = heavy ? 2600 : 2200;

    const env = ctx.createGain();
    const peak = (accent ? 0.78 : 0.56) * (heavy ? 1.2 : 1);
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(peak, time + 0.006);
    env.gain.exponentialRampToValueAtTime(0.08, time + 0.11);
    env.gain.linearRampToValueAtTime(0.0001, time + STEP_SECONDS * 0.92);

    dist.connect(filter);
    filter.connect(env);
    env.connect(master);
    env.connect(reverbSend);

    const voices: { ratio: number; type: OscillatorType; detune: number }[] = [
      { ratio: 1, type: "sawtooth", detune: -6 },
      { ratio: 1, type: "sawtooth", detune: 6 },
      { ratio: 1, type: "triangle", detune: 0 },
      { ratio: 1.5, type: "sawtooth", detune: 0 },
      { ratio: 2, type: "sawtooth", detune: 4 },
      // Chorus sections double an octave down for extra low-end weight —
      // the difference between a rhythm riff and a "wall of sound" riff.
      ...(heavy ? [{ ratio: 0.5, type: "sawtooth" as OscillatorType, detune: 0 }] : []),
    ];
    for (const v of voices) {
      const osc = ctx.createOscillator();
      osc.type = v.type;
      osc.frequency.value = freq * v.ratio;
      osc.detune.value = v.detune;
      osc.connect(dist);
      osc.start(time);
      osc.stop(time + STEP_SECONDS * 0.95);
    }
  }

  // String-section pad: three chord tones (root, fifth, octave), each
  // doubled with a slightly detuned partner voice — six oscillators per
  // chord is what turns "one synth note" into something that reads as an
  // ensemble. Slow attack/release so it swells rather than snaps in.
  function playPad(time: number, rootFreq: number, durationSeconds: number) {
    if (!ctx || !master || !reverbSend) return;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1800;
    filter.Q.value = 0.3;

    const env = ctx.createGain();
    const attack = Math.min(0.7, durationSeconds * 0.2);
    const release = Math.min(0.8, durationSeconds * 0.2);
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(0.32, time + attack);
    env.gain.setValueAtTime(0.32, time + durationSeconds - release);
    env.gain.linearRampToValueAtTime(0, time + durationSeconds);

    filter.connect(env);
    env.connect(master);
    env.connect(reverbSend);

    for (const ratio of [1, 1.5, 2]) {
      for (const detune of [-5, 5]) {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = rootFreq * ratio;
        osc.detune.value = detune;
        osc.connect(filter);
        osc.start(time);
        osc.stop(time + durationSeconds + 0.05);
      }
    }
  }

  // A short, bright, filtered stab standing in for a brass/orchestra hit,
  // landing on each chord change.
  function playBrassStab(time: number, freq: number) {
    if (!ctx || !master || !reverbSend) return;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = freq * 2.2;
    filter.Q.value = 0.9;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(0.4, time + 0.02);
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.4);

    filter.connect(env);
    env.connect(master);
    env.connect(reverbSend);

    for (const ratio of [1, 2]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = freq * ratio;
      osc.connect(filter);
      osc.start(time);
      osc.stop(time + 0.42);
    }
  }

  function playKick(time: number) {
    if (!ctx || !master) return;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    const env = ctx.createGain();
    osc.frequency.setValueAtTime(110, time);
    osc.frequency.exponentialRampToValueAtTime(38, time + 0.09);
    env.gain.setValueAtTime(0.5, time);
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.16);
    osc.connect(env);
    env.connect(master);
    osc.start(time);
    osc.stop(time + 0.18);
  }

  function playSnare(time: number) {
    if (!ctx || !master || !reverbSend || !noiseBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 900;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1900;
    bp.Q.value = 0.7;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.32, time);
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.14);
    src.connect(hp);
    hp.connect(bp);
    bp.connect(env);
    env.connect(master);
    env.connect(reverbSend);
    src.start(time);
    src.stop(time + 0.16);
  }

  function playHihat(time: number, open: boolean) {
    if (!ctx || !master || !noiseBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7500;
    const env = ctx.createGain();
    const dur = open ? 0.14 : 0.035;
    env.gain.setValueAtTime(0.1, time);
    env.gain.exponentialRampToValueAtTime(0.001, time + dur);
    src.connect(hp);
    hp.connect(env);
    env.connect(master);
    src.start(time);
    src.stop(time + dur + 0.02);
  }

  function scheduler() {
    if (!ctx) return;
    while (nextStepTime < ctx.currentTime + SCHEDULE_AHEAD_SECONDS) {
      const posInSong = stepIndex % STEPS_PER_SONG;
      const sectionIndex = Math.floor(posInSong / STEPS_PER_SECTION);
      const section = SONG[sectionIndex];
      const posInSection = posInSong % STEPS_PER_SECTION;
      const barInSection = Math.floor(posInSection / STEPS_PER_BAR);
      const barStep = posInSection % STEPS_PER_BAR;
      const isLastBarOfSection = barInSection === BARS_PER_SECTION - 1;
      const pattern = isLastBarOfSection ? RIFF_TURNAROUND : section.riff;
      const note = pattern[barStep];
      const accent = barStep === 0 || barStep === 4;

      if (note !== null) playGuitarChord(nextStepTime, note, accent, section.heavy);

      if (section.heavy) {
        // Four-on-the-floor double kick, driving chorus energy.
        if (barStep % 2 === 0) playKick(nextStepTime);
        if (barStep === 2 || barStep === 6) playSnare(nextStepTime);
        playHihat(nextStepTime, barStep % 4 === 3);
      } else {
        if (barStep === 0 || barStep === 4) playKick(nextStepTime);
        if (barStep === 2 || barStep === 6) playSnare(nextStepTime);
        playHihat(nextStepTime, barStep === 6);
      }

      // Pad swell and brass stab once per section, on the downbeat.
      if (posInSection === 0) {
        playPad(nextStepTime, section.pad, STEPS_PER_SECTION * STEP_SECONDS);
        playBrassStab(nextStepTime, section.pad);
      }

      stepIndex++;
      nextStepTime += STEP_SECONDS;
    }
  }

  return {
    unlock() {
      ensureContext();
      if (ctx && ctx.state === "suspended") ctx.resume();
    },
    start() {
      ensureContext();
      if (!ctx || running) return;
      if (ctx.state === "suspended") ctx.resume();
      running = true;
      stepIndex = 0;
      nextStepTime = ctx.currentTime + 0.05;
      scheduler();
      timerId = setInterval(scheduler, LOOKAHEAD_MS);
    },
    stop() {
      running = false;
      if (timerId !== null) {
        clearInterval(timerId);
        timerId = null;
      }
    },
    setMuted(next: boolean) {
      muted = next;
      if (master && ctx) {
        master.gain.setTargetAtTime(muted ? 0 : 0.16, ctx.currentTime, 0.05);
      }
    },
    dispose() {
      this.stop();
      if (ctx) {
        ctx.close().catch(() => {});
        ctx = null;
        master = null;
        reverbSend = null;
        noiseBuffer = null;
      }
    },
  };
}
