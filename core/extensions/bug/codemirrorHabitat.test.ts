import { Text } from "@codemirror/state";

import {
  blockChannels,
  blockSpan,
  channelsSounding,
  filterSoundingEdibles,
} from "./codemirrorHabitat";
import type { EdibleCode } from "./types";

function docOf(...lines: string[]) {
  return Text.of(lines);
}

function edible(overrides: Partial<EdibleCode> & { from: number; to: number }): EdibleCode {
  return {
    id: `${overrides.from}:${overrides.to}`,
    text: "",
    kind: "modifier",
    nutrition: 1,
    heat: 0,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    ...overrides,
  };
}

describe("blockSpan", () => {
  test("expands to the surrounding paragraph", () => {
    const doc = docOf('d1 $ s "bd"', "  # room 0.8", "", 'd2 $ s "hh"');
    expect(blockSpan(doc, 5, 5)).toEqual({
      from: 0,
      to: doc.line(2).to,
    });
  });

  test("clamps out-of-range positions", () => {
    const doc = docOf('d1 $ s "bd"');
    expect(blockSpan(doc, -99, 999)).toEqual({ from: 0, to: doc.length });
  });
});

describe("blockChannels", () => {
  test("finds channels of the enclosing block", () => {
    const doc = docOf('d1 $ s "bd"', "  # room 0.8", "", 'd2 $ s "hh"');
    expect(blockChannels(doc, 15, 15)).toEqual(new Set(["1"]));
    expect(blockChannels(doc, doc.length, doc.length)).toEqual(
      new Set(["2"])
    );
  });

  test("ignores commented channels", () => {
    const commented = docOf("-- d9 $ s \"bd\"");
    expect(blockChannels(commented, 0, 0)).toEqual(new Set());
    const doc = docOf("-- d9 $ s \"bd\"", 'd3 $ s "hh"');
    expect(blockChannels(doc, 0, 0)).toEqual(new Set(["3"]));
  });
});

describe("channelsSounding", () => {
  test("matches numeric channels against the active set", () => {
    expect(channelsSounding(new Set(["1", "3"]), new Set([3]))).toBe(true);
    expect(channelsSounding(new Set(["1"]), new Set([2]))).toBe(false);
    expect(channelsSounding(new Set(), new Set([1]))).toBe(false);
  });
});

describe("filterSoundingEdibles", () => {
  const doc = docOf('d1 $ s "bd" # room 0.8', "", 'd2 $ s "hh" # pan 0.5');
  const first = edible({ from: 12, to: 22, text: "# room 0.8" });
  const second = edible({
    from: doc.line(3).from + 12,
    to: doc.line(3).to,
    text: "# pan 0.5",
  });

  test("keeps only edibles on sounding blocks", () => {
    expect(filterSoundingEdibles(doc, [first, second], new Set([2]))).toEqual([
      second,
    ]);
  });

  test("keeps everything when the active set is unknown", () => {
    expect(filterSoundingEdibles(doc, [first, second], null)).toEqual([
      first,
      second,
    ]);
  });
});
