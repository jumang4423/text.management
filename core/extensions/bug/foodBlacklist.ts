import type { FoodKind } from "./types";

export interface TidalFoodBlacklist {
  /** Control names used after #, for example `gain` in `# gain 0.8`. */
  controls: readonly string[];
  /** Standalone Tidal function names, for example `fast` or `jux`. */
  functions: readonly string[];
  /** Exact candidate text, after trimming surrounding whitespace. */
  exact: readonly string[];
}

// Add future exclusions here. Names are matched case-insensitively.
export const TIDAL_FOOD_BLACKLIST: TidalFoodBlacklist = {
  // These can mute a voice outright, select a missing sample, invalidate a
  // slice, or route events away even when the expression still type-checks.
  controls: ["gain", "n", "orbit", "begin", "end"],
  functions: [],
  exact: [],
};

function normalizedSet(values: readonly string[]) {
  return new Set(values.map((value) => value.trim().toLowerCase()));
}

const blockedControls = normalizedSet(TIDAL_FOOD_BLACKLIST.controls);
const blockedFunctions = normalizedSet(TIDAL_FOOD_BLACKLIST.functions);
const blockedExactText = normalizedSet(TIDAL_FOOD_BLACKLIST.exact);

export function isTidalFoodBlacklisted(source: string, kind: FoodKind) {
  const trimmed = source.trim();
  const normalized = trimmed.toLowerCase();
  if (blockedExactText.has(normalized)) return true;

  if (kind === "modifier") {
    const control = trimmed.match(/^#\s*([A-Za-z][\w']*)/)?.[1];
    return control ? blockedControls.has(control.toLowerCase()) : false;
  }

  if (kind === "function") return blockedFunctions.has(normalized);
  return false;
}
