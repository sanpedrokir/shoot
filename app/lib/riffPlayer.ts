// A procedurally synthesized "orchestra-rock" hybrid score — no audio file
// or sample library needed, everything is generated in-browser with the Web
// Audio API. Four layers make up the mix:
//   - A distorted guitar riff (the "rock" backbone, chugging eighth notes).
//   - A slow-swelling string-section pad underneath (many detuned
//     oscillators per note — the classic trick for turning a single
//     synth voice into something that reads as an ensemble rather than one
//     buzzy tone).
//   - Short brass-like stabs accenting each chord change (the "orchestra
//     hit" you'd hear in a trailer score).
//   - A light drum layer (kick, snare, hi-hat) built from filtered noise
//     bursts and a pitched sine thump, for a real rhythmic backbone instead
//     of just the riff's own gating.
// A convolution reverb send glues all four together with a sense of room,
// and a compressor on the master bus keeps the mix from clipping as layers
// stack — both of which do more for "sounding less synthetic" than any
// single voice's timbre does. Notes are scheduled sample-accurately ahead of
// time (the standard Web Audio "lookahead scheduler" pattern) so timing
// stays tight regardless of setInterval jitter.

const TEMPO_BPM = 142;
const BEAT_SECONDS = 60 / TEMPO_BPM;
const STEP_SECONDS = BEAT_SECONDS / 2; // eighth notes
const STEPS_PER_BAR = 8;
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_SECONDS = 0.12;

// Root note per eighth-note step, one bar of 8 — a simple E-power-chord riff
// with a couple of walk-ups, repeated. Frequencies are low (guitar low-E
// register) for weight.
const E2 = 82.41;
const G2 = 98.0;
const A2 = 110.0;
const RIFF: number[] = [E2, E2, G2, E2, A2, E2, G2, E2];

// A slower harmonic rhythm for the string pad and brass stabs underneath the
// riff — a common "epic" progression (i minor - VI - III - VII), one chord
// every 2 bars, voiced an octave above the guitar so the two layers don't
// compete for the same register.
const E3 = 164.81;
const C3 = 130.81;
const G3 = 196.0;
const D3 = 146.83;
const PAD_PROGRESSION: number[] = [E3, C3, G3, D3];
const BARS_PER_CHORD = 2;
const STEPS_PER_CHORD = STEPS_PER_BAR * BARS_PER_CHORD;

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
  function playGuitarChord(time: number, freq: number, accent: boolean) {
    if (!ctx || !master || !reverbSend) return;
    const dist = ctx.createWaveShaper();
    dist.curve = makeDistortionCurve(24);
    dist.oversample = "4x";

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 2200;

    const env = ctx.createGain();
    const peak = accent ? 0.78 : 0.56;
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
      const barStep = stepIndex % STEPS_PER_BAR;
      const accent = barStep === 0;

      playGuitarChord(nextStepTime, RIFF[barStep], accent);
      if (barStep === 0 || barStep === 4) playKick(nextStepTime);
      if (barStep === 2 || barStep === 6) playSnare(nextStepTime);
      playHihat(nextStepTime, barStep === 6);

      if (stepIndex % STEPS_PER_CHORD === 0) {
        const chordIndex = Math.floor(stepIndex / STEPS_PER_CHORD) % PAD_PROGRESSION.length;
        const rootFreq = PAD_PROGRESSION[chordIndex];
        playPad(nextStepTime, rootFreq, STEPS_PER_CHORD * STEP_SECONDS);
        playBrassStab(nextStepTime, rootFreq);
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
