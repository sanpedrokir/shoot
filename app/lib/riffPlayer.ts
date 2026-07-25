// A procedurally synthesized, looping power-chord riff — no audio file
// needed. Two detuned sawtooth oscillators per chord (root + fifth) run
// through a distortion curve and a lowpass filter for a crunchy, overdriven
// guitar tone, gated by a short percussive envelope so it "chugs" instead of
// droning. A low sine thump on the downbeats stands in for a kick drum.
// Notes are scheduled sample-accurately ahead of time (the standard Web
// Audio "lookahead scheduler" pattern) so timing stays tight regardless of
// setInterval jitter.

const TEMPO_BPM = 142;
const BEAT_SECONDS = 60 / TEMPO_BPM;
const STEP_SECONDS = BEAT_SECONDS / 2; // eighth notes
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_SECONDS = 0.12;

// Root note per eighth-note step, one bar of 8 — a simple E-power-chord riff
// with a couple of walk-ups, repeated. Frequencies are low (guitar low-E
// register) for weight.
const E2 = 82.41;
const G2 = 98.0;
const A2 = 110.0;
const RIFF: number[] = [E2, E2, G2, E2, A2, E2, G2, E2];

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
  let timerId: ReturnType<typeof setInterval> | null = null;
  let nextStepTime = 0;
  let stepIndex = 0;
  let running = false;
  let muted = false;

  function ensureContext() {
    if (ctx) return;
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.16;
    master.connect(ctx.destination);
  }

  function playChord(time: number, freq: number, accent: boolean) {
    if (!ctx || !master) return;
    const dist = ctx.createWaveShaper();
    dist.curve = makeDistortionCurve(28);
    dist.oversample = "4x";

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 2400;

    const env = ctx.createGain();
    const peak = accent ? 0.9 : 0.65;
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(peak, time + 0.006);
    env.gain.exponentialRampToValueAtTime(0.08, time + 0.11);
    env.gain.linearRampToValueAtTime(0.0001, time + STEP_SECONDS * 0.92);

    dist.connect(filter);
    filter.connect(env);
    env.connect(master);

    for (const ratio of [1, 1.5, 2]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = freq * ratio;
      osc.connect(dist);
      osc.start(time);
      osc.stop(time + STEP_SECONDS * 0.95);
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

  function scheduler() {
    if (!ctx) return;
    while (nextStepTime < ctx.currentTime + SCHEDULE_AHEAD_SECONDS) {
      const freq = RIFF[stepIndex % RIFF.length];
      const accent = stepIndex % 4 === 0;
      playChord(nextStepTime, freq, accent);
      if (stepIndex % 4 === 0) playKick(nextStepTime);
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
      }
    },
  };
}
