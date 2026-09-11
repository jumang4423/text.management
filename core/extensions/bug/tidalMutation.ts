import { isTidalFoodBlacklisted } from "./foodBlacklist";
import { isBugReelModeEnabled } from "./reelMode";
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

// Only direct numeric arguments with a known domain are edible. Expressions,
// strings and unrelated numbers (including d-channel names) are left alone.
const argumentDomains: Readonly<Record<string, "rate" | "count" | "probability">> = {
  fast: "rate", slow: "rate", fastGap: "rate", density: "rate",
  sparsity: "rate", hurry: "rate", loopAt: "rate",
  inside: "rate", outside: "rate",
  segment: "count", discretise: "count", chop: "count", striate: "count",
  randslice: "count", iter: "count", scramble: "count", shuffle: "count",
  stripe: "count", every: "count", chunk: "count", run: "count", scan: "count",
  sometimesBy: "probability", someCyclesBy: "probability",
};

export function numericArgumentRanges(code: string) {
  const pattern = new RegExp(
    `\\b(${Object.keys(argumentDomains).join("|")})(\\s+)(\\d+(?:\\.\\d+)?)(?![\\w.'])(?=\\s|[)$]|$)`,
    "g"
  );
  return Array.from(code.matchAll(pattern)).flatMap((match) => {
    const from = match.index! + match[1].length + match[2].length;
    const to = from + match[3].length;
    // Do not nibble just the numerator or operand of an arithmetic expression.
    if (/^\s*[/+*%<>=-]/.test(code.slice(to))) return [];
    if (argumentDomains[match[1]] === "count" && match[3].includes(".")) return [];
    return [{ from, to, argumentFunction: match[1] }];
  });
}

function mutateArgument(
  source: string, name: string | undefined, random: Random, reelMode: boolean
) {
  const domain = name ? argumentDomains[name] : undefined;
  const original = Number(source);
  if (!domain || !Number.isFinite(original)) return source;
  const integer = domain === "count";
  const minimum = domain === "probability" ? 0 : integer ? 1 : 0.0625;
  const maximum = domain === "probability" ? 1 : reelMode ? 64 : 16;
  let next = reelMode
    ? random.between(minimum, maximum)
    : original * (1 + (random.next() < 0.5 ? -1 : 1) * random.between(0.12, 0.4));
  // Normal mode retains large existing arguments, with a proportional nudge.
  const upper = reelMode || domain === "probability"
    ? maximum
    : Math.max(maximum, original * 1.4);
  next = clamp(next, minimum, upper);
  if (formatNumber(next, integer) === formatNumber(original, integer)) {
    const step = integer ? 1 : Math.max(0.01, original * 0.18);
    next = clamp(original + (original >= upper ? -step : step), minimum, upper);
  }
  return formatNumber(next, integer);
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

function mutateModifier(source: string, random: Random, reelMode: boolean) {
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

  let minimum = 0;
  let maximum = 128;
  if (unitIntervalControls.has(control)) {
    minimum = 0;
    maximum = 1;
  } else if (control === "gain") {
    minimum = 0.05;
    maximum = 2;
  } else if (control === "speed") {
    minimum = 0.05;
    maximum = 4;
  } else if (integer) {
    minimum = 0;
    maximum = 128;
  }

  if (reelMode) {
    // Draw a fresh value across the full domain instead of nudging the old one.
    // Keep normalized controls and gain within their existing useful bounds.
    if (control === "speed") {
      minimum = 0.05;
      maximum = 16;
    } else if (!unitIntervalControls.has(control) && control !== "gain") {
      minimum = 0;
      maximum = 512;
    }
    next = random.between(minimum, maximum);
  }

  if (control === "segment" || control === "segments" || control === "coarse") minimum = 1;
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
    next = 0.125;
  }

  return `${prefix}${formatNumber(next, integer)}${suffix}`;
}

export function mutateTidalText(
  source: string,
  kind: FoodKind,
  random: Random,
  reelMode = isBugReelModeEnabled(),
  argumentFunction?: string
) {
  if (isTidalFoodBlacklisted(source, kind)) return source;
  if (kind === "argument") return mutateArgument(source, argumentFunction, random, reelMode);
  if (kind === "modifier") return mutateModifier(source, random, reelMode);
  return mutateFunction(source, random);
}
