// Loops a real audio file for the background score instead of synthesizing
// one. `start(src)` takes the track to play — solo and co-op games use
// different files — and only reassigns the underlying element's src (which
// restarts playback from 0) when it's actually changing, so replaying the
// same track mid-session doesn't stutter.

export interface MusicPlayer {
  // Primes playback on a user gesture without audibly starting yet (browsers
  // block audio.play() outside a gesture). Playing then immediately pausing
  // is the standard trick — after this, start() can be called later from a
  // non-gesture context (e.g. a network event on the ally's client) and
  // still succeed. `src` here just needs to be *a* valid track to prime
  // with; start() will switch to whichever track is actually wanted.
  unlock(src: string): void;
  start(src: string): void;
  stop(): void;
  setMuted(muted: boolean): void;
  dispose(): void;
  // True once the element is actually producing sound (not just that we
  // called play() -- some mobile/in-app browsers silently ignore a play()
  // call even from what looks like a valid gesture, so callers use this to
  // decide whether to show an explicit "tap to enable sound" fallback.
  isPlaying(): boolean;
}

const VOLUME = 0.5;

export function createMusicPlayer(): MusicPlayer {
  let audio: HTMLAudioElement | null = null;
  let currentSrc: string | null = null;
  let muted = false;

  function ensure() {
    if (audio) return;
    audio = new Audio();
    audio.loop = true;
    audio.preload = "auto";
    audio.volume = muted ? 0 : VOLUME;
  }

  function setTrack(src: string) {
    ensure();
    if (currentSrc === src) return;
    currentSrc = src;
    audio!.src = src;
  }

  return {
    unlock(src: string) {
      setTrack(src);
      audio!
        .play()
        .then(() => audio?.pause())
        .catch(() => {
          // No track there yet, or the browser still refused — harmless,
          // start() will just no-op silently until a file exists.
        });
    },
    start(src: string) {
      setTrack(src);
      audio!.play().catch(() => {});
    },
    stop() {
      audio?.pause();
    },
    setMuted(next: boolean) {
      muted = next;
      if (audio) audio.volume = muted ? 0 : VOLUME;
    },
    dispose() {
      if (audio) {
        audio.pause();
        audio.src = "";
        audio = null;
        currentSrc = null;
      }
    },
    isPlaying() {
      return !!audio && !audio.paused && !audio.ended && audio.currentTime > 0;
    },
  };
}
