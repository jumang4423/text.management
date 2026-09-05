// DOM-free sizing helpers for sample image/emoji tokens.
// Kept separate so they can be unit tested under plain node jest.

// All tokens render at one unified size regardless of name length, so long
// names (e.g. "industrial") no longer dwarf short ones (e.g. "mc").
export const sampleEmojiFixedSize = 6.0;

// Positive per-side clearance shared by images and emoji.
export const sampleEmojiGapCh = 0;

export function emojiSizeFor(scale = 1) {
  return sampleEmojiFixedSize * scale;
}

// Per-side layout shift (in ch, signed) so the token occupies the unified
// size plus the gap: short names push neighbours aside, long names pull
// them in. Resolves against the token's own (normal) font size, so unlike
// `ch` on the enlarged ::before it never compounds.
export function sampleLayoutShiftCh(
  sampleLength: number,
  suffixLength: number,
  scale = 1
) {
  const textLength = sampleLength + suffixLength;
  if (textLength <= 0) return 0;
  return (emojiSizeFor(scale) - textLength) / 2 + sampleEmojiGapCh;
}

// Visual width (image box, highlight) as % of the token's content box.
// Margins are excluded from the % basis, so nothing gets counted twice and
// "mc" vs "mc:1" render at the same size.
export function imageBoxWidthPct(
  sampleLength: number,
  suffixLength: number,
  scale = 1
) {
  const textLength = sampleLength + suffixLength;
  if (textLength <= 0) return 100;
  return (emojiSizeFor(scale) / textLength) * 100;
}
