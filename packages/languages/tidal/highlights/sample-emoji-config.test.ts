jest.mock("./sample-emojis.json", () => ({
  __esModule: true,
  default: {
    bd: { emoji: "🥁" },
    strudelsine: {
      emoji: "💿",
      source: "user-synth",
      completionName: "strudelSine",
    },
  },
}));

import {
  isUserSynthEmoji,
  sampleEmojiDefinition,
  sampleEmojiForName,
  userSynthNames,
} from "./sample-emoji-config";

describe("sample emoji definitions", () => {
  test("recognizes strudelSine as a user synth", () => {
    const definition = sampleEmojiDefinition("strudelSine");

    expect(definition).toBeDefined();
    expect(definition && isUserSynthEmoji(definition)).toBe(true);
    expect(sampleEmojiForName("STRUDELSINE")).toBe("💿");
    expect(userSynthNames).toEqual(["strudelSine"]);
  });

  test("keeps ordinary sample definitions as samplers", () => {
    const definition = sampleEmojiDefinition("bd");

    expect(definition).toBeDefined();
    expect(definition && isUserSynthEmoji(definition)).toBe(false);
  });
});
