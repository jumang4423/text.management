jest.mock("./sample-emojis.json", () => ({
  __esModule: true,
  default: {
    bd: { emoji: "🥁" },
    strudelsine: { emoji: "💿", source: "user-synth" },
  },
}));

import {
  isUserSynthEmoji,
  sampleEmojiDefinition,
  sampleEmojiForName,
} from "./sample-emoji-config";

describe("sample emoji definitions", () => {
  test("recognizes strudelSine as a user synth", () => {
    const definition = sampleEmojiDefinition("strudelSine");

    expect(definition).toBeDefined();
    expect(definition && isUserSynthEmoji(definition)).toBe(true);
    expect(sampleEmojiForName("STRUDELSINE")).toBe("💿");
  });

  test("keeps ordinary sample definitions as samplers", () => {
    const definition = sampleEmojiDefinition("bd");

    expect(definition).toBeDefined();
    expect(definition && isUserSynthEmoji(definition)).toBe(false);
  });
});
