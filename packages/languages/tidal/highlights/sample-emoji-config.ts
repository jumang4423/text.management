import definitions from "./sample-emojis.json";

import mcImageUrl from "./images/mc.png";
import funnyImageUrl from "./images/funny.png";

export interface SampleEmojiDefinition {
  emoji?: string;
  image?: string;
  scale?: number;
  source?: "sampler" | "user-synth";
  completionName?: string;
}

// Bundler-resolved image URLs. JSON stores a stable key, Parcel rewrites the
// import to a hashed asset URL at build time. Add new entries here when a new
// local image is added under ./images/.
const bundledSampleImageUrls: Record<string, string> = {
  "./images/mc.png": mcImageUrl,
  "./images/funny.png": funnyImageUrl,
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
  return sampleEmojiDefinitions[name.toLowerCase()];
}

export function sampleEmojiForName(name: string) {
  return sampleEmojiDefinition(name)?.emoji;
}

export function sampleImageUrlForName(name: string) {
  const definition = sampleEmojiDefinition(name);
  if (!definition?.image) return undefined;
  if (/^(data:|https?:\/\/)/.test(definition.image)) return definition.image;
  return bundledSampleImageUrls[definition.image] ?? definition.image;
}

export function hasSampleImage(
  nameOrDefinition: string | SampleEmojiDefinition
) {
  const definition =
    typeof nameOrDefinition === "string"
      ? sampleEmojiDefinition(nameOrDefinition)
      : nameOrDefinition;
  return definition?.image !== undefined;
}

export function isUserSynthEmoji(
  definition: SampleEmojiDefinition
) {
  return definition.source === "user-synth";
}
