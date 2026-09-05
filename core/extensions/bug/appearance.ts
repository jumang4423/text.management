import type { CaterpillarBodyOptions } from "./body";

// segmentCount includes the face (node 0).
// Each legPairNodes entry adds two legs, one on each side of that torso node.
export const BUG_BODY_PRESETS = {
  compact: {
    segmentCount: 4,
    legPairNodes: [1,2,3],
  },
  original: {
    segmentCount: 5,
    legPairNodes: [1, 2, 3, 4],
  },
} as const satisfies Record<string, CaterpillarBodyOptions>;

// Switch to "original" to restore the previous five-node, eight-leg appearance.
export const BUG_BODY_PRESET: keyof typeof BUG_BODY_PRESETS = "compact";
