jest.mock("./sample-emojis.json", () => ({
  __esModule: true,
  default: {
    bd: { emoji: "🥁" },
    strudelsine: {
      emoji: "💿",
      source: "user-synth",
      completionName: "strudelSine",
    },
    mc: { image: "./images/mc.png" },
  },
}));

import {
  hasSampleImage,
  isUserSynthEmoji,
  sampleEmojiDefinition,
  sampleEmojiForName,
  sampleImageUrlForName,
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

  test("resolves an image-only sample without an emoji fallback", () => {
    const definition = sampleEmojiDefinition("mc");

    expect(definition).toEqual({ image: "./images/mc.png" });
    expect(sampleEmojiForName("mc")).toBeUndefined();
    expect(hasSampleImage("mc")).toBe(true);
    expect(hasSampleImage("bd")).toBe(false);
    // Bundled via __mocks__/file.ts in Jest.
    expect(sampleImageUrlForName("mc")).toBe("test-file-stub");
    expect(sampleImageUrlForName("bd")).toBeUndefined();
  });
});
