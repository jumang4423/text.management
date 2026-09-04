import type { ElectronAPI } from "../preload";

// Minecraft-style munching: while the bug chews, play one of the mc_eat
// samples (eat1-3) at random every ~0.45s. Sample bytes come from the main
// process, which reads them out of the `samples/mc_eat` bank, so this works
// without SuperCollider running.
export class MunchPlayer {
  private readonly sounds: HTMLAudioElement[] = [];
  // A munch that arrives before its samples (or before the first user
  // gesture) is replayed instead of dropped.
  private pending = false;
  private lastRequestedAt = 0;
  private static readonly REQUEST_THROTTLE_MS = 1_000;

  constructor(private api: typeof ElectronAPI) {
    // Browsers block Audio.play() before the first user gesture. Prime the
    // cached elements on that gesture so later munches play immediately.
    window.addEventListener("pointerdown", this.unlockOnGesture);
    window.addEventListener("keydown", this.unlockOnGesture);
    let logged = false;
    this.api.onMunchSampleData(({ index, mime, data }) => {
      const bytes = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
      ) as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      let audio = this.sounds[index];
      if (!audio) {
        audio = new Audio();
        audio.preload = "auto";
        this.sounds[index] = audio;
      } else if (audio.src.startsWith("blob:")) {
        URL.revokeObjectURL(audio.src);
      }
      audio.src = url;
      if (!logged && this.sounds.filter((entry) => entry?.src).length >= 3) {
        logged = true;
        console.info("[munch-sounds] samples ready");
      }
      if (this.pending) {
        this.pending = false;
        this.play();
      }
    });
  }

  private readonly unlockOnGesture = () => {
    window.removeEventListener("pointerdown", this.unlockOnGesture);
    window.removeEventListener("keydown", this.unlockOnGesture);
    for (const audio of this.sounds) {
      if (!audio?.src) continue;
      const volume = audio.volume;
      audio.volume = 0;
      try {
        void audio
          .play()
          .then(() => audio.pause())
          .catch(() => {});
      } catch {
        // ignore; the next munch will retry
      }
      audio.volume = volume;
    }
    // Flush anything that was blocked before the first gesture.
    if (this.pending) {
      this.pending = false;
      this.play();
    }
  };

  prefetch() {
    // The first request can race main-process startup (its listeners attach
    // on ready-to-show), so requests are throttled rather than one-shot.
    const now = performance.now();
    if (now - this.lastRequestedAt < MunchPlayer.REQUEST_THROTTLE_MS) {
      return;
    }
    this.lastRequestedAt = now;
    this.api.requestMunchSamples();
  }

  play() {
    const ready = this.sounds.filter((audio) => audio?.src);
    if (ready.length === 0) {
      this.pending = true;
      this.prefetch();
      return;
    }
    const audio = ready[Math.floor(Math.random() * ready.length)];
    try {
      audio.currentTime = 0;
      void audio.play().catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "NotAllowedError") {
          this.pending = true;
        }
      });
    } catch {
      // Autoplay may be blocked before the first user gesture; the pending
      // flag replays it once audio is unlocked.
      this.pending = true;
    }
  }
}
