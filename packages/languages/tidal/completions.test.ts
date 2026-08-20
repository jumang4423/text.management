import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";

jest.mock("./highlights/sample-emojis.json", () => ({
  __esModule: true,
  default: {
    bd: { emoji: "🥁" },
    bskick: { emoji: "💥" },
    foley: { emoji: "🪵" },
  },
}));

import {
  recordTidalCompletionUsage,
  setTidalFunctionCompletions,
  setTidalSampleCompletions,
  tidalCompletionSource,
} from "./completions";

const storedValues = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    clear: () => storedValues.clear(),
    getItem: (key: string) => storedValues.get(key) ?? null,
    setItem: (key: string, value: string) => storedValues.set(key, value),
  },
});

function complete(document: string) {
  const state = EditorState.create({ doc: document });
  const context = new CompletionContext(state, document.length, false);
  return tidalCompletionSource(context);
}

describe("Tidal completions", () => {
  beforeEach(() => {
    localStorage.clear();
    setTidalFunctionCompletions(["every", "fast", "fastCat", "myFunction"]);
    setTidalSampleCompletions(["bd", "foley", "bskick"]);
  });

  it("offers live GHCi names in code", () => {
    const result = complete("fa");
    expect(result?.options.map(({ label }) => label)).toEqual([
      "every",
      "fast",
      "fastCat",
      "myFunction",
    ]);
  });

  it("offers sample banks inside a string", () => {
    const result = complete('d1 $ s "fo');
    expect(result?.options.map(({ label }) => label)).toEqual([
      "bd",
      "bskick",
      "foley",
    ]);
  });

  it("boosts frequently evaluated names", () => {
    recordTidalCompletionUsage('d1 $ fast 2 $ s "foley foley"');
    recordTidalCompletionUsage('d1 $ fast 4 $ s "foley"');

    const functions = complete("fa");
    const samples = complete('d1 $ s "fo');
    const fast = functions?.options.find(({ label }) => label === "fast");
    const every = functions?.options.find(({ label }) => label === "every");
    const foley = samples?.options.find(({ label }) => label === "foley");
    const bd = samples?.options.find(({ label }) => label === "bd");

    expect(fast?.boost).toBeGreaterThan(every?.boost ?? 0);
    expect(foley?.boost).toBeGreaterThan(bd?.boost ?? 0);
  });
});
