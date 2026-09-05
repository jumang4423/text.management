import {
  emojiSizeFor,
  imageBoxWidthPct,
  sampleEmojiFixedSize,
  sampleLayoutShiftCh,
} from "./sample-image-layout";

describe("sample image layout", () => {
  test("all names share one unified size", () => {
    expect(emojiSizeFor()).toBe(sampleEmojiFixedSize);
    expect(emojiSizeFor(2)).toBe(sampleEmojiFixedSize * 2);
  });

  test("short names shift neighbours aside minus the gap", () => {
    expect(sampleLayoutShiftCh(2, 0)).toBeCloseTo(1.5, 10);
    expect(sampleLayoutShiftCh(2, 2)).toBeCloseTo(0.5, 10);
  });

  test("long names like industrial pull neighbours in", () => {
    expect(sampleLayoutShiftCh(10, 0)).toBeCloseTo(-2.5, 10);
  });

  test("shifted layout is one gap tighter than the unified size", () => {
    // text + 2 * shift === unified size - 2 * gap for every token.
    expect(2 + sampleLayoutShiftCh(2, 0) * 2).toBeCloseTo(5.0, 10);
    expect(4 + sampleLayoutShiftCh(2, 2) * 2).toBeCloseTo(5.0, 10);
    expect(10 + sampleLayoutShiftCh(10, 0) * 2).toBeCloseTo(5.0, 10);
  });

  test("image box % is against the text width", () => {
    // 300% of 2ch, 150% of 4ch and 60% of 10ch all render as 6ch.
    expect(imageBoxWidthPct(2, 0)).toBeCloseTo(300, 10);
    expect(imageBoxWidthPct(2, 2)).toBeCloseTo(150, 10);
    expect(imageBoxWidthPct(10, 0)).toBeCloseTo(60, 10);
  });

  test("larger-than-text visuals stay centered inside", () => {
    expect(imageBoxWidthPct(10, 0)).toBeLessThan(100);
  });
});
