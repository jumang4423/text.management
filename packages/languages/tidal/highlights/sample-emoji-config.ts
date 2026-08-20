import definitions from "./sample-emojis.json";

export interface SampleEmojiDefinition {
  emoji: string;
  scale?: number;
  source?: "sampler" | "user-synth";
  completionName?: string;
}

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

export function isUserSynthEmoji(
  definition: SampleEmojiDefinition
) {
  return definition.source === "user-synth";
}
