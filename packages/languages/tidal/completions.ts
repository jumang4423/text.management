import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";

import { sampleEmojiForName } from "./highlights/sample-emoji-config";

type CompletionKind = "function" | "sample";

interface UsageEntry {
  count: number;
  lastUsed: number;
}

const usageStorageKey = "text-management:tidal-completion-usage-v1";
const completionToken = /[A-Za-z0-9_][A-Za-z0-9_'-]*/g;
const completionTokenAtCursor = /[A-Za-z0-9_][A-Za-z0-9_'-]*$/;
const completionTokenWhileTyping = /^[A-Za-z0-9_][A-Za-z0-9_'-]*$/;

let functionNames: string[] = [];
let sampleNames: string[] = [];
let functionNameSet = new Set<string>();
let sampleNameSet = new Set<string>();

export function setTidalFunctionCompletions(names: readonly string[]) {
  functionNames = uniqueSorted(names);
  functionNameSet = new Set(functionNames);
}

export function setTidalSampleCompletions(names: readonly string[]) {
  sampleNames = uniqueSorted(names);
  sampleNameSet = new Set(sampleNames);
}

export function recordTidalCompletionUsage(code: string) {
  const usage = readUsage();
  const now = Date.now();
  let changed = false;

  for (const name of code.match(completionToken) ?? []) {
    if (functionNameSet.has(name)) {
      incrementUsage(usage, "function", name, now);
      changed = true;
    }
    if (sampleNameSet.has(name)) {
      incrementUsage(usage, "sample", name, now);
      changed = true;
    }
  }

  if (changed) writeUsage(usage);
}

export function tidalCompletions() {
  return autocompletion({
    override: [tidalCompletionSource],
    maxRenderedOptions: 80,
  });
}

export function tidalCompletionSource(
  context: CompletionContext
): CompletionResult | null {
  const token = context.matchBefore(completionTokenAtCursor);
  if (!token || (token.from === token.to && !context.explicit)) return null;

  const inString = cursorIsInsideString(context);
  const kind: CompletionKind = inString ? "sample" : "function";
  const names = inString ? sampleNames : functionNames;
  const usage = readUsage();

  return {
    from: token.from,
    options: names.map((name): Completion => {
      const emoji = kind === "sample" ? sampleEmojiForName(name) : undefined;
      return {
        label: name,
        detail: emoji ? `${emoji} sample` : "Tidal",
        type: kind === "sample" ? "variable" : "function",
        boost: usageBoost(usage[usageKey(kind, name)]),
      };
    }),
    validFor: completionTokenWhileTyping,
  };
}

function cursorIsInsideString(context: CompletionContext) {
  const line = context.state.doc.lineAt(context.pos);
  const before = context.state.sliceDoc(line.from, context.pos);
  let quoted = false;
  let escaped = false;

  for (const character of before) {
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    }
  }

  return quoted;
}

function uniqueSorted(names: readonly string[]) {
  return [...new Set(names)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

function usageKey(kind: CompletionKind, name: string) {
  return `${kind}:${name}`;
}

function incrementUsage(
  usage: Record<string, UsageEntry>,
  kind: CompletionKind,
  name: string,
  now: number
) {
  const key = usageKey(kind, name);
  const previous = usage[key];
  usage[key] = {
    count: (previous?.count ?? 0) + 1,
    lastUsed: now,
  };
}

function usageBoost(entry: UsageEntry | undefined) {
  if (!entry) return 0;

  const ageInDays = Math.max(0, Date.now() - entry.lastUsed) / 86_400_000;
  const frequency = Math.log2(entry.count + 1) * 14;
  const recency = Math.max(0, 14 - ageInDays * 2);
  return Math.min(99, Math.round(frequency + recency));
}

function readUsage(): Record<string, UsageEntry> {
  try {
    const value = JSON.parse(localStorage.getItem(usageStorageKey) ?? "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function writeUsage(usage: Record<string, UsageEntry>) {
  try {
    localStorage.setItem(usageStorageKey, JSON.stringify(usage));
  } catch {
    // Completion still works when storage is unavailable.
  }
}
