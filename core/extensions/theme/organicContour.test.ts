import { extendCurveToTop, isDegenerateContour } from "./organicContour";

describe("isDegenerateContour", () => {
  it("hides empty and single-point contours", () => {
    expect(isDegenerateContour([])).toBe(true);
    expect(isDegenerateContour([{ x: 200, y: 10 }])).toBe(true);
  });

  it("hides the single-line plumb line", () => {
    const plumb = [
      { x: 200, y: 0 },
      { x: 200, y: 120 },
      { x: 201, y: 400 },
      { x: 200, y: 900 },
    ];
    expect(isDegenerateContour(plumb)).toBe(true);
  });

  it("keeps contours with real horizontal shape", () => {
    const wavy = [
      { x: 200, y: 0 },
      { x: 260, y: 120 },
      { x: 190, y: 400 },
      { x: 250, y: 900 },
    ];
    expect(isDegenerateContour(wavy)).toBe(false);
  });

  it("treats near-threshold amplitude as degenerate", () => {
    const narrow = [
      { x: 200, y: 0 },
      { x: 223, y: 900 },
    ];
    expect(isDegenerateContour(narrow)).toBe(true);
    const wide = [
      { x: 200, y: 0 },
      { x: 224, y: 900 },
    ];
    expect(isDegenerateContour(wide)).toBe(false);
  });
});

describe("extendCurveToTop", () => {
  it("prepends a point at the top edge", () => {
    const points = [
      { x: 200, y: 300 },
      { x: 210, y: 500 },
    ];
    const extended = extendCurveToTop(points, -12, 800);
    expect(extended).toHaveLength(3);
    expect(extended[0].y).toBe(-12);
    expect(extended[1]).toEqual({ x: 200, y: 300 });
    expect(extended[2]).toEqual({ x: 210, y: 500 });
  });

  it("returns points unchanged when already at or above the top", () => {
    const points = [
      { x: 200, y: 10 },
      { x: 210, y: 500 },
    ];
    expect(extendCurveToTop(points, 10, 800)).toEqual(points);
    expect(extendCurveToTop(points, 50, 800)).toEqual(points);
    expect(extendCurveToTop([], -12, 800)).toEqual([]);
  });

  it("does not mutate inputs", () => {
    const points = [
      { x: 200, y: 300 },
      { x: 210, y: 500 },
    ];
    extendCurveToTop(points, -12, 800);
    expect(points).toEqual([
      { x: 200, y: 300 },
      { x: 210, y: 500 },
    ]);
  });
});
