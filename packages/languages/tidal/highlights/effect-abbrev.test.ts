import { findEffectSpans } from "./effect-abbrev";

describe("findEffectSpans", () => {
  test("splits around strings so minis keep their pipeline", () => {
    expect(findEffectSpans('# pan (range "0.2 0.5" 2.0 rand)')).toEqual([
      { from: 0, to: 13, abbrev: "#p(r" },
      { from: 22, to: 32, abbrev: "r)" },
    ]);
  });

  test("drops numbers and squeezes functions to first letters", () => {
    expect(findEffectSpans("# gain 0.8")).toEqual([
      { from: 0, to: 10, abbrev: "#g" },
    ]);
    expect(findEffectSpans('d1 $ s "bd" # speed 2')).toEqual([
      { from: 12, to: 21, abbrev: "#s" },
    ]);
  });

  test("splits chains at the next hash", () => {
    expect(findEffectSpans("# gain 0.8 # pan 0.5")).toEqual([
      { from: 0, to: 10, abbrev: "#g" },
      { from: 11, to: 20, abbrev: "#p" },
    ]);
  });

  test("keeps other symbols", () => {
    expect(findEffectSpans("# pan (slow 2 $ x)")).toEqual([
      { from: 0, to: 18, abbrev: "#p(s$x)" },
    ]);
  });

  test("ignores hashes in strings and comments", () => {
    expect(findEffectSpans('s "# gain"')).toEqual([]);
    expect(findEffectSpans("-- # gain 0.8")).toEqual([]);
    expect(findEffectSpans('s "a\\"b" # pan 0.5')).toEqual([
      { from: 9, to: 18, abbrev: "#p" },
    ]);
  });

  test("skips what it cannot abbreviate", () => {
    expect(findEffectSpans("#")).toEqual([]);
    expect(findEffectSpans("# 123")).toEqual([]);
    expect(findEffectSpans("# pan (range 2.0")).toEqual([]);
  });
});
