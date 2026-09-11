import { RangeSetBuilder, type EditorState } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

import { paragraphRange } from "@management/cm-evaluate";
import { chewingDecorations } from "@core/extensions/bug/codemirrorHabitat";

import "./effect-abbrev.css";

export interface EffectSpan {
  from: number;
  to: number;
  abbrev: string;
}

const wordStart = /[A-Za-z]/;
const wordChar = /[\w']/;
const digitChar = /[0-9]/;

// The source with strings and comments blanked to exactly the same
// length, so masked offsets map back onto the source one to one.
function maskExact(source: string): string {
  let code = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const pair = source.slice(i, i + 2);
    if (depth > 0) {
      if (pair === "{-") {
        depth += 1;
        code += "  ";
        i += 1;
      } else if (pair === "-}") {
        depth -= 1;
        code += "  ";
        i += 1;
      } else {
        code += char === "\n" ? "\n" : " ";
      }
    } else if (quoted) {
      if (char === "\\" && i + 1 < source.length) {
        code += "  ";
        i += 1;
      } else {
        code += char === "\n" ? "\n" : " ";
        if (char === '"') quoted = false;
      }
    } else if (pair === "{-") {
      depth = 1;
      code += "  ";
      i += 1;
    } else if (pair === "--") {
      while (i < source.length && source[i] !== "\n") {
        code += " ";
        i += 1;
      }
      if (i < source.length) code += "\n";
    } else if (char === '"') {
      quoted = true;
      code += " ";
    } else {
      code += char;
    }
  }
  return code;
}

// Abbreviate one `# name args...` span starting at hash. Functions
// shrink to their first letter, numbers and whitespace drop out, brackets
// stay. Quoted mininotation is left intact so the mini pipeline (sample
// images, sounding highlights) keeps working inside effects: the span is
// emitted as fragments around each string. Returns null with the resume
// position when not abbreviatable; spans stay on one line.
function abbreviateSpan(
  source: string,
  hash: number
): { parts: EffectSpan[]; end: number } | null {
  const endOfLine = source.indexOf("\n", hash);
  const limit = endOfLine < 0 ? source.length : endOfLine;
  const blank = (char: string) => char === " " || char === "\t";
  let index = hash + 1;
  while (index < limit && blank(source[index])) index += 1;
  if (index >= limit || !wordStart.test(source[index])) return null;
  let name = "";
  while (index < limit && wordChar.test(source[index])) {
    name += source[index];
    index += 1;
  }
  const parts: EffectSpan[] = [];
  let out = `#${name[0]}`;
  let segStart = hash;
  const flush = (to: number) => {
    if (out.length > 0 && to > segStart) {
      parts.push({ from: segStart, to, abbrev: out });
    }
    out = "";
    segStart = to;
  };
  let depth = 0;
  while (index < limit) {
    const pair = source.slice(index, index + 2);
    const char = source[index];
    if (blank(char)) {
      index += 1;
      continue;
    }
    if (pair === "--" || pair === "{-") break;
    if (char === "#") {
      if (depth > 0) return null;
      break;
    }
    if (char === "(") {
      depth += 1;
      out += char;
      index += 1;
      continue;
    }
    if (char === ")") {
      if (depth === 0) break;
      depth -= 1;
      out += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      let close = index + 1;
      while (close < limit) {
        if (source[close] === "\\") {
          close += 2;
          continue;
        }
        if (source[close] === '"') break;
        close += 1;
      }
      if (close >= limit) return null;
      flush(index);
      segStart = close + 1;
      index = close + 1;
      continue;
    }
    if (
      digitChar.test(char) ||
      (char === "-" && digitChar.test(source[index + 1] ?? ""))
    ) {
      if (char === "-") index += 1;
      while (
        index < limit &&
        (digitChar.test(source[index]) || source[index] === ".")
      ) {
        index += 1;
      }
      continue;
    }
    if (wordStart.test(char)) {
      out += char;
      index += 1;
      while (index < limit && wordChar.test(source[index])) index += 1;
      continue;
    }
    out += char;
    index += 1;
  }
  if (depth !== 0) return null;
  let to = index;
  while (to > hash && blank(source[to - 1])) to -= 1;
  flush(to);
  return { parts, end: to };
}

// `# effect ...` spans with their one-line abbreviations, split around
// quoted strings. Source text is never modified; positions refer to it
// directly. Hashes inside strings and comments are found blanked via the
// length-exact mask, then each candidate is lexed from the source.
export function findEffectSpans(source: string): EffectSpan[] {
  const masked = maskExact(source);
  const spans: EffectSpan[] = [];
  let hash = masked.indexOf("#", 0);
  while (hash >= 0) {
    const span = abbreviateSpan(source, hash);
    if (span) {
      spans.push(...span.parts);
      hash = masked.indexOf("#", span.end);
    } else {
      hash = masked.indexOf("#", hash + 1);
    }
  }
  return spans;
}

// Paragraph blocks holding each selection head: abbreviated spans
// overlapping these show their source instead.
export function cursorBlockRanges(
  state: EditorState
): { from: number; to: number }[] {
  const doc = state.doc;
  const seen = new Set<string>();
  const ranges: { from: number; to: number }[] = [];
  for (const range of state.selection.ranges) {
    const block = paragraphRange(doc, range.head);
    const key = `${block.from}:${block.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ranges.push(block);
  }
  return ranges;
}

function spanRevealed(
  span: EffectSpan,
  state: EditorState,
  blocks: { from: number; to: number }[]
): boolean {
  if (blocks.some((block) => span.from < block.to && span.to > block.from)) {
    return true;
  }
  return state.selection.ranges.some(
    (range) => range.from < span.to && range.to > span.from
  );
}

class EffectAbbrevWidget extends WidgetType {
  constructor(
    readonly abbrev: string,
    readonly full: string,
    readonly chewing = false
  ) {
    super();
  }

  eq(other: EffectAbbrevWidget): boolean {
    return (
      other instanceof EffectAbbrevWidget &&
      other.abbrev === this.abbrev &&
      other.chewing === this.chewing
    );
  }

  toDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className =
      "cm-effect-abbrev" + (this.chewing ? " cm-effect-abbrev-chewing" : "");
    element.textContent = this.abbrev;
    element.title = this.full;
    return element;
  }
}

function readChewing(state: EditorState): DecorationSet | null {
  try {
    return state.field(chewingDecorations);
  } catch {
    // The bug habitat is not mounted here; nothing chews.
    return null;
  }
}

function isChewing(
  chewing: DecorationSet | null,
  from: number,
  to: number
): boolean {
  if (!chewing) return false;
  let found = false;
  chewing.between(from, to, () => {
    found = true;
    return false;
  });
  return found;
}

function buildEffectAbbrev(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  const blocks = cursorBlockRanges(state);
  const chewing = readChewing(state);
  for (const span of findEffectSpans(doc.toString())) {
    if (spanRevealed(span, state, blocks)) continue;
    builder.add(
      span.from,
      span.to,
      Decoration.replace({
        widget: new EffectAbbrevWidget(
          span.abbrev,
          doc.sliceString(span.from, span.to),
          isChewing(chewing, span.from, span.to)
        ),
      })
    );
  }
  return builder.finish();
}

// Shows `# effect ...` chains abbreviated; the cursor block and any
// selection keep their source so editing and copying stay exact.
export function effectAbbrev() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private chewing: DecorationSet | null;

      constructor(view: EditorView) {
        this.chewing = readChewing(view.state);
        this.decorations = buildEffectAbbrev(view.state);
      }

      update(update: ViewUpdate) {
        const chewing = readChewing(update.state);
        if (
          update.docChanged ||
          !update.startState.selection.eq(update.state.selection) ||
          chewing !== this.chewing
        ) {
          this.chewing = chewing;
          this.decorations = buildEffectAbbrev(update.state);
        }
      }
    },
    { decorations: (value) => value.decorations }
  );
}
