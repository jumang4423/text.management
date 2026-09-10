import { parseActiveOrbitsMarker } from "./parse";

describe("parseActiveOrbitsMarker", () => {
  test("parses several orbits", () => {
    expect(parseActiveOrbitsMarker("TM-ACTIVE 1 3")).toEqual([1, 3]);
  });

  test("parses an empty marker as no active orbits", () => {
    expect(parseActiveOrbitsMarker("TM-ACTIVE")).toEqual([]);
  });

  test("finds the marker among other output lines", () => {
    expect(
      parseActiveOrbitsMarker('t> \nTM-ACTIVE 2\n"done"')
    ).toEqual([2]);
  });

  test("returns null when there is no marker", () => {
    expect(parseActiveOrbitsMarker("tidal> ")).toBeNull();
    expect(parseActiveOrbitsMarker(undefined)).toBeNull();
  });

  test("rejects malformed markers", () => {
    expect(parseActiveOrbitsMarker("TM-ACTIVE 1 x")).toBeNull();
    expect(parseActiveOrbitsMarker("XTM-ACTIVE 1")).toBeNull();
  });
});
