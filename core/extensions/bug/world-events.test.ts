jest.mock("./renderer", () => ({
  BugRenderer: jest.fn().mockImplementation(() => ({ render: jest.fn() })),
  droppingAtPoint: jest.fn(() => null),
}));

import { BugWorld } from "./world";
import type {
  EatenMatter,
  EdibleCode,
  HabitatAdapter,
  HabitatSnapshot,
} from "./types";

const food: EdibleCode = {
  id: "food-1",
  from: 0,
  to: 12,
  text: 'd1 $ sound "bd"',
  kind: "function",
  nutrition: 1,
  heat: 0,
  rect: { x: 400, y: 300, width: 200, height: 40 },
};

function makeSnapshot(): HabitatSnapshot {
  return {
    worldWidth: 1200,
    worldHeight: 1200,
    viewportWidth: 1200,
    viewportHeight: 800,
    scrollX: 0,
    scrollY: 0,
    canvasOffsetX: 0,
    canvasOffsetY: 0,
    activeLineRect: null,
    edibles: [food],
  };
}

function makeHabitat(): HabitatAdapter {
  return {
    snapshot: () => makeSnapshot(),
    syncCamera: () => {},
    stageToWorld: (point) => point,
    setChewing: () => {},
    eat: (edible): EatenMatter | null => ({
      id: edible.id,
      text: edible.text,
      mutatedText: edible.text,
      kind: edible.kind,
      nutrition: 1,
    }),
    restore: () => true,
    pulseRandom: () => null,
    undoLastBite: () => {},
  };
}

describe("BugWorld sound events", () => {
  it("fires munch during chewing and wiggle/release around pooping", () => {
    const world = new BugWorld(
      makeHabitat(),
      {} as unknown as HTMLCanvasElement
    );
    let munches = 0;
    let wiggles = 0;
    let releases = 0;
    world.onMunch = () => {
      munches += 1;
    };
    world.onPoopSound = (kind) => {
      if (kind === "wiggle") wiggles += 1;
      else releases += 1;
    };

    let now = 1_000;
    const step = 1 / 60;
    // Up to 120 simulated seconds: forage, chew (3s), then toilet.
    for (let i = 0; i < 120 * 60; i += 1) {
      now += step * 1_000;
      (world as unknown as { step: (d: number, n: number) => void }).step(
        step,
        now
      );
      if (munches >= 5 && wiggles >= 1 && releases >= 1) break;
    }

    expect(munches).toBeGreaterThanOrEqual(5);
    expect(wiggles).toBeGreaterThanOrEqual(1);
    expect(releases).toBeGreaterThanOrEqual(1);
  });
});
