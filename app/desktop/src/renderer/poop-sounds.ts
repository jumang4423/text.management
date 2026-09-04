import type { ElectronAPI } from "../preload";
import type { PoopSoundKind } from "@core/extensions/bug/types";

// Playback gain per kind. funny25 (wiggle) plays at 80%, funny26
// (release) stays at full volume.
const POOP_GAIN: Record<PoopSoundKind, number> = {
  wiggle: 0.6,
  release: 0.9,
};

// Plays the poop jingles (funny25 on wiggle, funny26 on release).
// Sample bytes come from the main process, which reads them out of the
// `samples/funny` bank, so this works without SuperCollider running.
export class PoopSoundPlayer {
  private readonly sounds = new Map<PoopSoundKind, HTMLAudioElement>();
  // Events that arrived before their sample (or before the first user
  // gesture) are replayed instead of dropped, so the first wiggle is
  // never silent.
  private readonly pending = new Set<PoopSoundKind>();
  private lastRequestedAt = 0;
  private static readonly REQUEST_THROTTLE_MS = 1_000;

  constructor(private api: typeof ElectronAPI) {
    // Browsers block Audio.play() before the first user gesture. Prime the
    // cached elements on that gesture so later poop events play immediately.
    window.addEventListener("pointerdown", this.unlockOnGesture);
    window.addEventListener("keydown", this.unlockOnGesture);
    let logged = false;
    this.api.onPoopSampleData(({ kind, mime, data }) => {
      const bytes = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
      ) as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      let audio = this.sounds.get(kind);
      if (!audio) {
        audio = new Audio();
        audio.preload = "auto";
        this.sounds.set(kind, audio);
      } else if (audio.src.startsWith("blob:")) {
        URL.revokeObjectURL(audio.src);
      }
      audio.volume = POOP_GAIN[kind];
      audio.src = url;
      if (!logged && this.sounds.size >= 2) {
        logged = true;
        console.info("[poop-sounds] samples ready");
      }
      if (this.pending.delete(kind)) {
        this.play(kind);
      }
    });
  }

  private readonly unlockOnGesture = () => {
    window.removeEventListener("pointerdown", this.unlockOnGesture);
    window.removeEventListener("keydown", this.unlockOnGesture);
    for (const audio of this.sounds.values()) {
      if (!audio.src) continue;
      const volume = audio.volume;
      audio.volume = 0;
      try {
        void audio
          .play()
          .then(() => audio.pause())
          .catch(() => {});
      } catch {
        // ignore; the next poop event will retry
      }
      audio.volume = volume;
    }
    // Flush anything that was blocked before the first gesture.
    for (const kind of [...this.pending]) {
      this.pending.delete(kind);
      this.play(kind);
    }
  };

  prefetch() {
    // The first request can race main-process startup (its listeners attach
    // on ready-to-show), so requests are throttled rather than one-shot:
    // play() re-requests on every cache miss.
    const now = performance.now();
    if (now - this.lastRequestedAt < PoopSoundPlayer.REQUEST_THROTTLE_MS) {
      return;
    }
    this.lastRequestedAt = now;
    this.api.requestPoopSamples();
  }

  play(kind: PoopSoundKind) {
    const audio = this.sounds.get(kind);
    if (!audio || !audio.src) {
      this.pending.add(kind);
      this.prefetch();
      return;
    }
    try {
      audio.currentTime = 0;
      void audio.play().catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "NotAllowedError") {
          this.pending.add(kind);
        }
      });
    } catch {
      // Autoplay may be blocked before the first user gesture; the pending
      // queue replays it once audio is unlocked.
      this.pending.add(kind);
    }
  }
}
