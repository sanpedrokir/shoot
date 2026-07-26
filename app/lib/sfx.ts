// Tiny one-shot UI sound effects, synthesized on the fly via Web Audio
// rather than loaded from a file — these are short enough (under a quarter
// second) that generating them beats shipping and preloading an asset.

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

// Called from the same early page-wide gesture listener that unlocks music,
// so the shared AudioContext is already created/resumed well before the
// first in-game hit/pickup sound is needed (those fire from the RAF game
// loop, not from a click handler, so they can't reliably unlock it themselves).
export function primeAudioContext() {
  getContext();
}

// A quick filtered-noise "swish" with a downward frequency sweep — reads as
// a page turning rather than a generic UI click. Called directly from a
// click handler, so the AudioContext creation/resume above rides the same
// user gesture that autoplay policies require.
export function playPageFlipSound() {
  const audioCtx = getContext();
  if (!audioCtx) return;
  try {
    const duration = 0.22;
    const now = audioCtx.currentTime;
    const bufferSize = Math.floor(audioCtx.sampleRate * duration);
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;

    const filter = audioCtx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 0.8;
    filter.frequency.setValueAtTime(3400, now);
    filter.frequency.exponentialRampToValueAtTime(800, now + duration);

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.5, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(audioCtx.destination);

    noise.start(now);
    noise.stop(now + duration);
  } catch {
    // Sound is a nice-to-have — never let it block navigation.
  }
}

// A quick descending "zap" for an enemy plane going down -- a square-wave
// blip falling in pitch plus a short noise crackle for impact, rather than
// one clean tone, so it reads as a hit rather than a UI beep.
export function playEnemyHitSound() {
  const audioCtx = getContext();
  if (!audioCtx) return;
  try {
    const duration = 0.16;
    const now = audioCtx.currentTime;

    const osc = audioCtx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.exponentialRampToValueAtTime(80, now + duration);

    const oscGain = audioCtx.createGain();
    oscGain.gain.setValueAtTime(0.18, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc.connect(oscGain);
    oscGain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + duration);

    const crackleSize = Math.floor(audioCtx.sampleRate * 0.05);
    const crackleBuffer = audioCtx.createBuffer(1, crackleSize, audioCtx.sampleRate);
    const data = crackleBuffer.getChannelData(0);
    for (let i = 0; i < crackleSize; i++) data[i] = Math.random() * 2 - 1;
    const crackle = audioCtx.createBufferSource();
    crackle.buffer = crackleBuffer;
    const crackleGain = audioCtx.createGain();
    crackleGain.gain.setValueAtTime(0.22, now);
    crackleGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    crackle.connect(crackleGain);
    crackleGain.connect(audioCtx.destination);
    crackle.start(now);
  } catch {
    // Sound is a nice-to-have — never let it block gameplay.
  }
}

// A bright two-note upward chime for collecting a shield -- reads as a
// reward pickup rather than a hit or a UI click.
export function playShieldPickupSound() {
  const audioCtx = getContext();
  if (!audioCtx) return;
  try {
    const now = audioCtx.currentTime;
    const notes = [660, 990];
    notes.forEach((freq, i) => {
      const start = now + i * 0.08;
      const duration = 0.14;
      const osc = audioCtx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, start);
      const gain = audioCtx.createGain();
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.25, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + duration);
    });
  } catch {
    // Sound is a nice-to-have — never let it block gameplay.
  }
}
