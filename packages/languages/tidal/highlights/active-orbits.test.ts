import { EditorState, Text } from "@codemirror/state";

import {
  activeDTokenRanges,
  activeOrbitsField,
  flashActiveOrbitsEffect,
  flashActiveOrbitsField,
} from "./active-orbits";

function tokenTexts(doc: Text, active: ReadonlySet<number>) {
  return activeDTokenRanges(doc, active).map((range) =>
    doc.sliceString(range.from, range.to)
  );
}

describe("activeDTokenRanges", () => {
  test("covers only the d-number token, not the rest of the block", () => {
    const doc = Text.of(['d1 $ s "bd"', "  # gain 0.8", "", 'd2 $ s "hh"']);
    const ranges = activeDTokenRanges(doc, new Set([1]));
    expect(ranges).toHaveLength(1);
    expect(tokenTexts(doc, new Set([1]))).toEqual(["d1"]);
    expect(doc.sliceString(ranges[0].from, ranges[0].to)).toBe("d1");
  });

  test("covers several d-number tokens in one block", () => {
    const doc = Text.of(['d1 $ s "bd"', 'd2 $ s "hh"']);
    expect(tokenTexts(doc, new Set([1, 2]))).toEqual(["d1", "d2"]);
  });

  test("marks nothing when no orbit is active", () => {
    const doc = Text.of(['d1 $ s "bd"']);
    expect(activeDTokenRanges(doc, new Set())).toEqual([]);
  });

  test("marks nothing when the active set is unknown", () => {
    const doc = Text.of(['d1 $ s "bd"']);
    expect(activeDTokenRanges(doc, null)).toEqual([]);
  });

  test("marks nothing when the active orbit is not referenced", () => {
    const doc = Text.of(['d1 $ s "bd"']);
    expect(activeDTokenRanges(doc, new Set([2]))).toEqual([]);
  });

  test("ignores d-numbers inside comments", () => {
    const doc = Text.of(["-- d9 $ s \"bd\"", 'd3 $ s "hh"']);
    expect(tokenTexts(doc, new Set([9, 3]))).toEqual(["d3"]);
  });
});

describe("flashActiveOrbitsField", () => {
  test("starts idle and follows the flash effect", () => {
    const state = EditorState.create({
      extensions: [activeOrbitsField, flashActiveOrbitsField],
    });
    expect(state.field(flashActiveOrbitsField)).toBeNull();
    const flashed = state.update({
      effects: flashActiveOrbitsEffect.of(123),
    }).state;
    expect(flashed.field(flashActiveOrbitsField)).toBe(123);
    const cleared = flashed.update({
      effects: flashActiveOrbitsEffect.of(null),
    }).state;
    expect(cleared.field(flashActiveOrbitsField)).toBeNull();
  });
});
