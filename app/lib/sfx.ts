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
