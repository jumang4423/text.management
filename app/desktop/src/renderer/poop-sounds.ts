import type { ElectronAPI } from "../preload";
import type { PoopSoundKind } from "@core/extensions/bug/types";

// Plays the poop jingles through SuperDirt (funny25 on wiggle, funny26 on
// release). Fire-and-forget OSC, so timing stays tight and no sample bytes
// cross the IPC bridge. Requires SuperCollider running.
export class PoopSoundPlayer {
  constructor(private api: typeof ElectronAPI) {}

  play(kind: PoopSoundKind) {
    this.api.poopHit({ kind });
  }
}
