import type { McMiningState } from "./mc-mining-state";

const crumbleDelayMs = 55;
const respawnMs = 350;

const grassClip =
  "polygon(7.4219% 24.6094%,50% 3.5156%,92.5781% 24.6094%,92.5781% 32.2266%,50% 54.1016%,7.4219% 32.2266%)";

export interface McMiningMotion {
  transform: string;
  style: string;
  active: boolean;
}

const restingMiningMotion: McMiningMotion = {
  transform: "none",
  style: "",
  active: false,
};

export function mcMiningMotion(
  mining: McMiningState | undefined,
  now: number
): McMiningMotion {
  if (!mining) return restingMiningMotion;

  const breakAge = now - mining.breakAt;
  const breaking = breakAge >= crumbleDelayMs && breakAge < respawnMs;
  const fallTime = breaking ? Math.max(0, Math.min(255, breakAge) - 150) : 0;
  const fall = fallTime * fallTime * 0.003 / 110 * 100;
  const opacity = breaking
    ? Math.max(0, 1 - Math.max(0, breakAge - 200) / 55)
    : 1;
  const active = breaking;

  return {
    transform: fall > 0
      ? `translateY(${fall.toFixed(3)}%)`
      : "none",
    active,
    style: [
      `--mc-mining-clip: ${breaking ? grassClip : "none"}`,
      `--mc-mining-opacity: ${opacity.toFixed(3)}`,
    ].join("; "),
  };
}
