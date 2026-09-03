import { clamp, type Random } from "./math";
import type { FoodKind } from "./types";

// A family must preserve more than its Haskell shape: it must accept the same
// value domain and keep emitting events. Broad "type-compatible" swaps such as
// `speed -> n`, `lpf -> hpf`, or `segment -> fast` can compile while selecting
// a missing sample, filtering everything out, or feeding zero to ratio maths.
// Keep these groups deliberately conservative so every bite remains audible.
const symmetricFunctionFamilies: readonly (readonly string[])[] = [
  ["fast", "slow", "fastGap", "density", "sparsity"],
  ["segment", "discretise"],
  ["rev", "palindrome", "loopFirst", "brak", "press"],
  ["cat", "fastcat", "slowcat", "randcat", "stack"],
  [
    "always",
    "almostAlways",
    "often",
    "sometimes",
    "rarely",
    "someCycles",
  ],
  ["sometimesBy", "someCyclesBy"],
  [
    "sine",
    "cosine",
    "sine2",
    "cosine2",
    "saw",
    "saw2",
    "isaw",
    "isaw2",
    "tri",
    "tri2",
    "rand",
    "perlin",
  ],
  ["chop", "striate", "randslice"],
  ["struct", "mask"],
  ["iter", "scramble", "shuffle", "stripe"],
  ["every", "chunk"],
  ["inside", "outside"],
  ["zoom", "compress"],
];

const zeroCapableWaveforms = new Set([
  "sine",
  "cosine",
  "sine2",
  "cosine2",
  "saw",
  "saw2",
  "isaw",
  "isaw2",
  "tri",
  "tri2",
  "rand",
  "perlin",
]);

// These functions are narrower than the generic families above. Replacements
// are directional: a ControlPattern-only function may safely become a generic
// pattern transform, while the reverse is not always type-correct.
const directionalFunctionAlternatives: Readonly<Record<string, readonly string[]>> = {
  loopAt: [
    "hurry",
    "fast",
    "slow",
    "fastGap",
    "density",
    "sparsity",
  ],
  hurry: [
    "loopAt",
    "fast",
    "slow",
    "fastGap",
    "density",
    "sparsity",
  ],
  rangex: ["range"],
  run: ["scan"],
  smooth: ["rev", "palindrome", "press"],
  jux: ["superimpose"],
};

const functionAlternatives = new Map<string, string[]>();
for (const family of symmetricFunctionFamilies) {
  for (const name of family) {
    functionAlternatives.set(
      name,
      family.filter((alternative) => alternative !== name)
    );
  }
}
for (const [name, alternatives] of Object.entries(
  directionalFunctionAlternatives
)) {
  functionAlternatives.set(name, [...alternatives]);
}

export const mutableTidalFunctionNames = [...functionAlternatives.keys()];

export function isSafeTidalFunctionContext(
  name: string,
  line: string,
  index: number
) {
  if (!zeroCapableWaveforms.has(name)) return true;

  // A raw waveform can be used as the rate of fast/slow/loopAt. Replacing it
  // with a waveform that reaches exact zero can then produce a zero-denominator
  // Ratio. Only mutate waveforms inside a numeric range that stays off zero.
  const prefix = line.slice(0, index);
  const range = prefix.match(
    /\b(?:range|rangex)\s+(-?(?:\d+(?:\.\d*)?|\.\d+))\s+(-?(?:\d+(?:\.\d*)?|\.\d+))(?:\s*\$[^$]*)?\s*$/
  );
  if (!range) return false;
  const lower = Number(range[1]);
  const upper = Number(range[2]);
  return (
    Number.isFinite(lower) &&
    Number.isFinite(upper) &&
    Math.abs(lower) >= 0.001 &&
    Math.abs(upper) >= 0.001 &&
    Math.sign(lower) === Math.sign(upper)
  );
}

function mutateFunction(source: string, random: Random) {
  const alternatives = functionAlternatives.get(source);
  if (!alternatives || alternatives.length === 0) return source;
  return random.pick(alternatives) ?? source;
}

const unitIntervalControls = new Set([
  "begin",
  "delay",
  "delayfeedback",
  "dry",
  "end",
  "pan",
  "resonance",
  "room",
  "shape",
  "size",
  "wet",
]);

const integerControls = new Set([
  "coarse",
  "cut",
  "n",
  "orbit",
  "segment",
  "segments",
]);

function formatNumber(value: number, integer: boolean) {
  if (integer) return Math.round(value).toString();
  const rounded = Math.round(value * 1_000) / 1_000;
  return Object.is(rounded, -0) ? "0" : rounded.toString();
}

function mutateModifier(source: string, random: Random) {
  const match = source.match(
    /^(\s*#\s*([A-Za-z][\w']*)\s+)(-?(?:\d+(?:\.\d*)?|\.\d+))(\s*)$/
  );
  if (!match) return source;

  const [, prefix, rawControl, rawValue, suffix] = match;
  const control = rawControl.toLowerCase();
  const original = Number(rawValue);
  if (!Number.isFinite(original)) return source;

  const integer = integerControls.has(control);
  const direction = random.next() < 0.5 ? -1 : 1;
  const amount = random.between(0.12, 0.4);
  let next =
    original === 0
      ? direction * (integer ? 1 : random.between(0.12, 0.42))
      : original * (1 + direction * amount);

  let minimum = -128;
  let maximum = 128;
  if (unitIntervalControls.has(control)) {
    minimum = 0;
    maximum = 1;
  } else if (control === "gain") {
    minimum = 0.05;
    maximum = 2;
  } else if (control === "speed") {
    minimum = -4;
    maximum = 4;
  } else if (integer) {
    minimum = 0;
    maximum = 128;
  }

  next = clamp(next, minimum, maximum);
  if (integer) next = Math.round(next);

  // Clamping at a boundary can erase the random change. Move inward by one
  // audible step so every mutable dropping really contains a different value.
  if (formatNumber(next, integer) === formatNumber(original, integer)) {
    const step = integer ? 1 : Math.max(0.1, Math.abs(original) * 0.18);
    next = original >= maximum ? original - step : original + step;
    next = clamp(next, minimum, maximum);
    if (integer) next = Math.round(next);
  }

  if (control === "speed" && Math.abs(next) < 0.05) {
    next = direction * 0.125;
  }

  return `${prefix}${formatNumber(next, integer)}${suffix}`;
}

export function mutateTidalText(
  source: string,
  kind: FoodKind,
  random: Random
) {
  if (kind === "modifier") return mutateModifier(source, random);
  return mutateFunction(source, random);
}
