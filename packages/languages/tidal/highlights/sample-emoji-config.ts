import definitions from "./sample-emojis.json";

import funny1ImageUrl from "./images/funny-1.png";
import funny4ImageUrl from "./images/funny-4.png";
import funny5ImageUrl from "./images/funny-5.png";
import funny7ImageUrl from "./images/funny-7.png";
import funny8ImageUrl from "./images/funny-8.png";
import funny10ImageUrl from "./images/funny-10.png";
import funny12ImageUrl from "./images/funny-12.png";
import funny13ImageUrl from "./images/funny-13.png";
import funny15ImageUrl from "./images/funny-15.png";
import funny19ImageUrl from "./images/funny-19.png";
import mcImageUrl from "./images/mc.png";
import yumeImageUrl from "./images/yume.png";
import funnyImageUrl from "./images/funny.png";

export interface SampleEmojiDefinition {
  emoji?: string;
  image?: string;
  // Per-sample-index image overrides, keyed by normalized Tidal index
  // ("4" for `s "funny:4"`). Falls back to `image` when no override exists.
  // To add a new one: drop the PNG under ./images/, import it above, map it
  // in `bundledSampleImageUrls`, then add `"4": "./images/funny-4.png"`.
  imagesByIndex?: Record<string, string>;
  scale?: number;
  scalesByIndex?: Record<string, number>;
  source?: "sampler" | "user-synth";
  completionName?: string;
}

// Bundler-resolved image URLs. JSON stores a stable key, Parcel rewrites the
// import to a hashed asset URL at build time. Add new entries here when a new
// local image is added under ./images/.
const bundledSampleImageUrls: Record<string, string> = {
  "./images/mc.png": mcImageUrl,
  "./images/yume.png": yumeImageUrl,
  "./images/funny.png": funnyImageUrl,
  "./images/funny-1.png": funny1ImageUrl,
  "./images/funny-4.png": funny4ImageUrl,
  "./images/funny-5.png": funny5ImageUrl,
  "./images/funny-7.png": funny7ImageUrl,
  "./images/funny-8.png": funny8ImageUrl,
  "./images/funny-10.png": funny10ImageUrl,
  "./images/funny-12.png": funny12ImageUrl,
  "./images/funny-13.png": funny13ImageUrl,
  "./images/funny-15.png": funny15ImageUrl,
  "./images/funny-19.png": funny19ImageUrl,
};

const sampleEmojiDefinitions = definitions as Record<
  string,
  SampleEmojiDefinition
>;

export const sampleEmojiNames = Object.keys(sampleEmojiDefinitions);

export const userSynthNames = Object.entries(sampleEmojiDefinitions)
  .filter(([, definition]) => isUserSynthEmoji(definition))
  .map(([name, definition]) => definition.completionName ?? name);

export function sampleEmojiDefinition(name: string) {
  const lower = name.toLowerCase();
  const exact = sampleEmojiDefinitions[lower];
  if (exact) return exact;
  // Allow lookups like "funny:4" to fall back to the "funny" base entry.
  const colon = lower.indexOf(":");
  if (colon !== -1) return sampleEmojiDefinitions[lower.slice(0, colon)];
  return undefined;
}

export function sampleEmojiForName(name: string) {
  return sampleEmojiDefinition(name)?.emoji;
}

function resolveSampleImageKey(key: string | undefined) {
  if (!key) return undefined;
  if (/^(data:|https?:\/\/)/.test(key)) return key;
  return bundledSampleImageUrls[key] ?? key;
}

function normalizeSampleIndex(index: string | number): string | undefined {
  if (typeof index === "number") {
    if (!Number.isFinite(index)) return undefined;
    return String(Math.trunc(index));
  }
  const raw = String(index).trim();
  if (raw === "") return undefined;
  const afterColon = raw.includes(":")
    ? raw.slice(raw.lastIndexOf(":") + 1).trim()
    : raw;
  if (!/^-?\d+$/.test(afterColon)) return undefined;
  return String(Number.parseInt(afterColon, 10));
}

function sampleIndexFromName(name: string): string | undefined {
  const colon = name.indexOf(":");
  if (colon === -1) return undefined;
  return normalizeSampleIndex(name.slice(colon + 1));
}

function resolveSampleIndex(
  name: string,
  index?: string | number
): string | undefined {
  if (index !== undefined) {
    const normalized = normalizeSampleIndex(index);
    if (normalized !== undefined) return normalized;
  }
  return sampleIndexFromName(name);
}

export function sampleImageUrlForName(name: string, index?: string | number) {
  const definition = sampleEmojiDefinition(name);
  if (!definition) return undefined;
  const resolvedIndex = resolveSampleIndex(name, index);
  if (resolvedIndex !== undefined) {
    const variantUrl = resolveSampleImageKey(
      definition.imagesByIndex?.[resolvedIndex]
    );
    if (variantUrl) return variantUrl;
  }
  return resolveSampleImageKey(definition.image);
}

export function sampleVariantImageUrlForName(
  name: string,
  index?: string | number
) {
  const definition = sampleEmojiDefinition(name);
  if (!definition?.imagesByIndex) return undefined;
  const resolvedIndex = resolveSampleIndex(name, index);
  if (resolvedIndex === undefined) return undefined;
  return resolveSampleImageKey(definition.imagesByIndex[resolvedIndex]);
}

export function sampleScaleForName(name: string, index?: string | number) {
  const definition = sampleEmojiDefinition(name);
  if (!definition) return undefined;
  const resolvedIndex = resolveSampleIndex(name, index);
  if (resolvedIndex !== undefined) {
    const variantScale = definition.scalesByIndex?.[resolvedIndex];
    if (variantScale !== undefined) return variantScale;
  }
  return definition.scale;
}

export function hasSampleImage(
  nameOrDefinition: string | SampleEmojiDefinition,
  index?: string | number
) {
  const definition =
    typeof nameOrDefinition === "string"
      ? sampleEmojiDefinition(nameOrDefinition)
      : nameOrDefinition;
  if (!definition) return false;
  if (definition.image !== undefined) return true;
  // Base has no image: only true when this specific index has an override.
  const resolvedIndex =
    typeof nameOrDefinition === "string"
      ? resolveSampleIndex(nameOrDefinition, index)
      : index !== undefined
        ? normalizeSampleIndex(index)
        : undefined;
  return (
    resolvedIndex !== undefined &&
    definition.imagesByIndex?.[resolvedIndex] !== undefined
  );
}

export function isUserSynthEmoji(
  definition: SampleEmojiDefinition
) {
  return definition.source === "user-synth";
}
