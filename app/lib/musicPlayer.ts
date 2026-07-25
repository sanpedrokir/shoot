// Loops a real audio file for the background score instead of synthesizing
// one — drop the track at public/audio/theme.mp3. The interface mirrors
// what a synthesized player would expose (unlock/start/stop/setMuted/
// dispose) so the caller doesn't need to know which one it's using.

export interface MusicPlayer {
  // Primes playback on a user gesture without audibly starting yet (browsers
  // block audio.play() outside a gesture). Playing then immediately pausing
  // is the standard trick — after this, start() can be called later from a
  // non-gesture context (e.g. a network event on the ally's client) and
  // still succeed.
  unlock(): void;
  start(): void;
  stop(): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}

const VOLUME = 0.5;

export function createMusicPlayer(src: string): MusicPlayer {
  let audio: HTMLAudioElement | null = null;
  let muted = false;

  function ensure() {
    if (audio) return;
    audio = new Audio(src);
    audio.loop = true;
    audio.preload = "auto";
    audio.volume = muted ? 0 : VOLUME;
  }

  return {
    unlock() {
      ensure();
      audio!
        .play()
        .then(() => audio?.pause())
        .catch(() => {
          // No track at `src` yet, or the browser still refused — harmless,
          // start() will just no-op silently until a file exists.
        });
    },
    start() {
      ensure();
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
      }
    },
  };
}
