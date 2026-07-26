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

// A punchy impact for an enemy plane going down -- three layered noise/tone
// bursts (a sharp high-frequency "crack" transient, a low sine "thump" for
// body, and a lower-passed noise "debris" tail) instead of a single clean
// tonal sweep, so it reads as a real hit/impact rather than a retro laser
// zap (the previous square-wave-sweep version read as too synthetic).
export function playEnemyHitSound() {
  const audioCtx = getContext();
  if (!audioCtx) return;
  try {
    const now = audioCtx.currentTime;

    // Crack: the instant of impact -- a very short, sharp burst of
    // high-passed noise.
    const crackDuration = 0.05;
    const crackSize = Math.floor(audioCtx.sampleRate * crackDuration);
    const crackBuffer = audioCtx.createBuffer(1, crackSize, audioCtx.sampleRate);
    const crackData = crackBuffer.getChannelData(0);
    for (let i = 0; i < crackSize; i++) crackData[i] = Math.random() * 2 - 1;
    const crack = audioCtx.createBufferSource();
    crack.buffer = crackBuffer;
    const crackFilter = audioCtx.createBiquadFilter();
    crackFilter.type = "highpass";
    crackFilter.frequency.setValueAtTime(2200, now);
    const crackGain = audioCtx.createGain();
    crackGain.gain.setValueAtTime(0.4, now);
    crackGain.gain.exponentialRampToValueAtTime(0.001, now + crackDuration);
    crack.connect(crackFilter);
    crackFilter.connect(crackGain);
    crackGain.connect(audioCtx.destination);
    crack.start(now);

    // Thump: a brief low-frequency pulse for body/punch underneath the crack.
    const thump = audioCtx.createOscillator();
    thump.type = "sine";
    thump.frequency.setValueAtTime(150, now);
    thump.frequency.exponentialRampToValueAtTime(45, now + 0.09);
    const thumpGain = audioCtx.createGain();
    thumpGain.gain.setValueAtTime(0.35, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    thump.connect(thumpGain);
    thumpGain.connect(audioCtx.destination);
    thump.start(now);
    thump.stop(now + 0.1);

    // Debris tail: lower-passed noise decaying a bit longer than the crack,
    // reading as the plane breaking apart rather than a clean tone cutting off.
    const tailDuration = 0.14;
    const tailSize = Math.floor(audioCtx.sampleRate * tailDuration);
    const tailBuffer = audioCtx.createBuffer(1, tailSize, audioCtx.sampleRate);
    const tailData = tailBuffer.getChannelData(0);
    for (let i = 0; i < tailSize; i++) tailData[i] = Math.random() * 2 - 1;
    const tail = audioCtx.createBufferSource();
    tail.buffer = tailBuffer;
    const tailFilter = audioCtx.createBiquadFilter();
    tailFilter.type = "lowpass";
    tailFilter.frequency.setValueAtTime(2600, now);
    tailFilter.frequency.exponentialRampToValueAtTime(500, now + tailDuration);
    const tailGain = audioCtx.createGain();
    tailGain.gain.setValueAtTime(0.22, now + 0.01);
    tailGain.gain.exponentialRampToValueAtTime(0.001, now + tailDuration);
    tail.connect(tailFilter);
    tailFilter.connect(tailGain);
    tailGain.connect(audioCtx.destination);
    tail.start(now);
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

// A fast rising sawtooth sweep for grabbing Rapid Fire -- reads as an
// energizing "power up!" rather than the gentler shield chime, matching how
// much more aggressive the buff itself is.
export function playRapidFireSound() {
  const audioCtx = getContext();
  if (!audioCtx) return;
  try {
    const duration = 0.2;
    const now = audioCtx.currentTime;

    const osc = audioCtx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(280, now);
    osc.frequency.exponentialRampToValueAtTime(1400, now + duration);

    const filter = audioCtx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(2200, now);

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.22, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + duration);
  } catch {
    // Sound is a nice-to-have — never let it block gameplay.
  }
}

// A heavy low-to-high power-charge "womp" plus a bright metallic ping for
// grabbing a Smart Bomb -- distinct from Rapid Fire's brighter sawtooth
// sweep and the shield's gentle chime, matching how much bigger a "clear
// the whole screen" weapon feels than either of those.
export function playSmartBombPickupSound() {
  const audioCtx = getContext();
  if (!audioCtx) return;
  try {
    const now = audioCtx.currentTime;
    const duration = 0.32;

    const osc = audioCtx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(90, now);
    osc.frequency.linearRampToValueAtTime(220, now + duration);

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.3, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + duration);

    const pingStart = now + duration * 0.55;
    const ping = audioCtx.createOscillator();
    ping.type = "triangle";
    ping.frequency.setValueAtTime(1400, pingStart);
    const pingGain = audioCtx.createGain();
    pingGain.gain.setValueAtTime(0, pingStart);
    pingGain.gain.linearRampToValueAtTime(0.2, pingStart + 0.015);
    pingGain.gain.exponentialRampToValueAtTime(0.001, pingStart + 0.18);
    ping.connect(pingGain);
    pingGain.connect(audioCtx.destination);
    ping.start(pingStart);
    ping.stop(pingStart + 0.18);
  } catch {
    // Sound is a nice-to-have — never let it block gameplay.
  }
}

// A low, growling "roar" for the boss's arrival — a detuned pair of low
// sawtooth oscillators (for a rough, beating growl rather than one clean
// tone) plus filtered noise rumble underneath, both swept down in pitch and
// a low-pass filter opened up briefly to give it a "getting closer" bite.
export function playBossRoarSound() {
  const audioCtx = getContext();
  if (!audioCtx) return;
  try {
    const now = audioCtx.currentTime;
    const duration = 1.3;

    const master = audioCtx.createGain();
    master.gain.setValueAtTime(0, now);
    master.gain.linearRampToValueAtTime(0.35, now + 0.08);
    master.gain.linearRampToValueAtTime(0.3, now + duration * 0.6);
    master.gain.exponentialRampToValueAtTime(0.001, now + duration);
    master.connect(audioCtx.destination);

    const filter = audioCtx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(220, now);
    filter.frequency.linearRampToValueAtTime(900, now + duration * 0.35);
    filter.frequency.linearRampToValueAtTime(140, now + duration);
    filter.connect(master);

    for (const detune of [-6, 6]) {
      const osc = audioCtx.createOscillator();
      osc.type = "sawtooth";
      osc.detune.value = detune;
      osc.frequency.setValueAtTime(95, now);
      osc.frequency.linearRampToValueAtTime(140, now + duration * 0.3);
      osc.frequency.exponentialRampToValueAtTime(55, now + duration);
      osc.connect(filter);
      osc.start(now);
      osc.stop(now + duration);
    }

    const noiseSize = Math.floor(audioCtx.sampleRate * duration);
    const noiseBuffer = audioCtx.createBuffer(1, noiseSize, audioCtx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < noiseSize; i++) data[i] = Math.random() * 2 - 1;
    const noise = audioCtx.createBufferSource();
    noise.buffer = noiseBuffer;
    const noiseGain = audioCtx.createGain();
    noiseGain.gain.setValueAtTime(0.15, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    noise.connect(noiseGain);
    noiseGain.connect(filter);
    noise.start(now);
    noise.stop(now + duration);
  } catch {
    // Sound is a nice-to-have — never let it block gameplay.
  }
}

// A crisp two-note ascending confirm blip for picking a boss firepower
// loadout -- short and punchy (triangle wave, not the sine chime shields
// use) so it reads as "equipped" rather than "collected".
export function playSelectSound() {
  const audioCtx = getContext();
  if (!audioCtx) return;
  try {
    const now = audioCtx.currentTime;
    const notes = [520, 780];
    notes.forEach((freq, i) => {
      const start = now + i * 0.06;
      const duration = 0.09;
      const osc = audioCtx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, start);
      const gain = audioCtx.createGain();
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.28, start + 0.01);
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
