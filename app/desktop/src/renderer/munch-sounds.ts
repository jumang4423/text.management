import type { ElectronAPI } from "../preload";

const MUNCH_VARIANTS = 3;

// Minecraft-style munching through SuperDirt (mc_eat bank). Fire-and-forget
// OSC per bite, so rapid munches never pile up. Requires SuperCollider
// running.
export class MunchPlayer {
  constructor(private api: typeof ElectronAPI) {}

  play() {
    this.api.munchHit({
      index: Math.floor(Math.random() * MUNCH_VARIANTS),
    });
  }
}
