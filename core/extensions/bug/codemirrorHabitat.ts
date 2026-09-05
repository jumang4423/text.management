import { undo } from "@codemirror/commands";
import { StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  type DecorationSet,
} from "@codemirror/view";

import { clamp, Random, type Rect, type Vec2 } from "./math";
import {
  isSafeTidalFunctionContext,
  mutableTidalFunctionNames,
  mutateTidalText,
} from "./tidalMutation";
import { isTidalFoodBlacklisted } from "./foodBlacklist";
import type {
  EdibleCode,
  EatenMatter,
  FoodKind,
  HabitatAdapter,
  HabitatSnapshot,
} from "./types";

interface HeatSource {
  from: number;
  to: number;
  strength: number;
  createdAt: number;
}

interface CandidateRange {
  from: number;
  to: number;
  kind: FoodKind;
}

interface ChewingRange {
  from: number;
  to: number;
}

interface BiteAnchor {
  id: string;
  position: number;
}

const mutableFunctionPattern = new RegExp(
  `\\b(?:${mutableTidalFunctionNames.join("|")})\\b`,
  "g"
);

const setChewingRanges = StateEffect.define<readonly ChewingRange[]>();
const addBiteAnchor = StateEffect.define<BiteAnchor>();
const removeBiteAnchor = StateEffect.define<string>();

const chewingDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setChewingRanges)) continue;
      next = Decoration.set(
        effect.value.map((range) =>
          Decoration.mark({ class: "cm-bug-chewing" }).range(
            range.from,
            range.to
          )
        )
      );
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const biteAnchors = StateField.define<Map<string, number>>({
  create: () => new Map(),
  update(anchors, transaction) {
    const next = new Map<string, number>();
    for (const [id, position] of anchors) {
      next.set(id, transaction.changes.mapPos(position, 1));
    }
    for (const effect of transaction.effects) {
      if (effect.is(addBiteAnchor)) {
        next.set(effect.value.id, effect.value.position);
      } else if (effect.is(removeBiteAnchor)) {
        next.delete(effect.value);
      }
    }
    return next;
  },
});

export const bugHabitatExtension = [chewingDecorations, biteAnchors];

export class CodeMirrorHabitat implements HabitatAdapter {
  private readonly random = new Random(0xd16e57);
  private readonly heatSources: HeatSource[] = [];
  private lastSnapshot: HabitatSnapshot | null = null;
  private lastSnapshotAt = -Infinity;
  private revision = 0;
  private snapshotRevision = -1;
  private chewingFoodSignature = "";

  constructor(
    readonly view: EditorView,
    private readonly stage: HTMLElement
  ) {
    view.scrollDOM.addEventListener("scroll", this.invalidateViewport, {
      passive: true,
    });
  }

  destroy() {
    this.view.scrollDOM.removeEventListener("scroll", this.invalidateViewport);
  }

  invalidateDocument() {
    this.revision += 1;
  }

  refreshViewport() {
    this.lastSnapshotAt = -Infinity;
  }

  snapshot(now: number): HabitatSnapshot {
    if (
      this.lastSnapshot &&
      now - this.lastSnapshotAt < 180 &&
      this.snapshotRevision === this.revision
    ) {
      return this.lastSnapshot;
    }

    const scroll = this.view.scrollDOM;
    const scrollRect = scroll.getBoundingClientRect();
    const stageRect = this.stage.getBoundingClientRect();
    const contentRect = this.view.contentDOM.getBoundingClientRect();
    const contentX = contentRect.left - scrollRect.left + scroll.scrollLeft;
    const worldWidth = Math.max(
      scroll.clientWidth,
      scroll.scrollWidth,
      this.view.lineWrapping ? scroll.clientWidth :
        contentX + this.view.state.doc.length * this.view.defaultCharacterWidth * 0.03
    );
    const worldHeight = Math.max(
      scroll.clientHeight,
      this.view.contentHeight + this.view.defaultLineHeight * 2
    );
    const activeLine = this.view.state.doc.lineAt(
      this.view.state.selection.main.head
    );
    const activeLineBlock = this.view.lineBlockAt(activeLine.from);
    const cursorRect = this.view.coordsAtPos(this.view.state.selection.main.head);
    const activeLineRect: Rect = {
      x: contentX,
      y: cursorRect ? cursorRect.top - scrollRect.top + scroll.scrollTop : activeLineBlock.top,
      width: Math.max(
        120,
        Math.min(
          worldWidth - contentX,
          activeLine.length * this.view.defaultCharacterWidth
        )
      ),
      height: cursorRect ? cursorRect.bottom - cursorRect.top : this.view.defaultLineHeight,
    };

    while (
      this.heatSources.length > 0 &&
      now - this.heatSources[0].createdAt >= 7_000
    ) {
      this.heatSources.shift();
    }

    const snapshot: HabitatSnapshot = {
      worldWidth,
      worldHeight,
      viewportWidth: scroll.clientWidth,
      viewportHeight: scroll.clientHeight,
      scrollX: scroll.scrollLeft,
      scrollY: scroll.scrollTop,
      canvasOffsetX: scrollRect.left - stageRect.left,
      canvasOffsetY: scrollRect.top - stageRect.top,
      activeLineRect,
      edibles: this.extractEdibles(now),
    };
    this.lastSnapshot = snapshot;
    this.lastSnapshotAt = now;
    this.snapshotRevision = this.revision;
    return snapshot;
  }

  syncCamera(snapshot: HabitatSnapshot) {
    // Scrolling does not change food positions in document space. Keep the
    // expensive full-document food scan on its slower cadence, but copy the
    // live camera offset every animation frame so the canvas tracks inertial
    // scrolling without 220 ms jumps.
    snapshot.scrollX = this.view.scrollDOM.scrollLeft;
    snapshot.scrollY = this.view.scrollDOM.scrollTop;
  }

  stageToWorld(point: Vec2): Vec2 {
    const snapshot = this.snapshot(performance.now());
    return {
      x: point.x - snapshot.canvasOffsetX + snapshot.scrollX,
      y: point.y - snapshot.canvasOffsetY + snapshot.scrollY,
    };
  }

  setChewing(edibles: readonly EdibleCode[]) {
    const uniqueRanges = [
      ...new Map(
        edibles.map((edible) => [
          `${edible.from}:${edible.to}`,
          { from: edible.from, to: edible.to },
        ])
      ).values(),
    ].sort((left, right) => left.from - right.from);
    const signature = uniqueRanges
      .map((range) => `${range.from}:${range.to}`)
      .join("|");
    if (signature === this.chewingFoodSignature) return;
    this.chewingFoodSignature = signature;
    this.view.dispatch({
      effects: setChewingRanges.of(uniqueRanges),
    });
  }

  eat(edible: EdibleCode): EatenMatter | null {
    const current = this.view.state.doc.sliceString(edible.from, edible.to);
    if (current !== edible.text) return null;
    if (isTidalFoodBlacklisted(current, edible.kind)) return null;
    const id = `${Date.now().toString(36)}-${edible.id}`;
    const mutatedText = mutateTidalText(current, edible.kind, this.random);
    const matter: EatenMatter = {
      id,
      text: current,
      mutatedText,
      kind: edible.kind,
      nutrition: edible.nutrition,
    };
    this.view.dispatch({
      changes: { from: edible.from, to: edible.to, insert: "" },
      effects: addBiteAnchor.of({ id, position: edible.from }),
    });
    this.invalidateDocument();
    return matter;
  }

  restore(matter: EatenMatter) {
    const tracked = this.view.state.field(biteAnchors).get(matter.id);
    if (tracked === undefined) return false;

    const doc = this.view.state.doc;
    const position = clamp(tracked, 0, doc.length);
    const candidates = [matter.text, matter.mutatedText];
    const alreadyRestored = candidates.some((candidate) => {
      const before = doc.sliceString(
        Math.max(0, position - candidate.length),
        position
      );
      const after = doc.sliceString(
        position,
        Math.min(doc.length, position + candidate.length)
      );
      return before === candidate || after === candidate;
    });

    this.view.dispatch(
      alreadyRestored
        ? { effects: removeBiteAnchor.of(matter.id) }
        : {
            changes: { from: position, insert: matter.mutatedText },
            effects: removeBiteAnchor.of(matter.id),
          }
    );
    this.invalidateDocument();
    return true;
  }

  pulseRandom(now: number) {
    const snapshot = this.snapshot(now);
    const visible = snapshot.edibles.filter((food) => {
      const y = food.rect.y - snapshot.scrollY;
      return y > 0 && y < snapshot.viewportHeight;
    });
    const candidates = visible.length > 0 ? visible : snapshot.edibles;
    if (candidates.length === 0) return null;
    const index = Math.floor(Math.random() * candidates.length);
    const food = candidates[index];
    const strength = 0.55 + Math.random() * 0.45;
    this.heatSources.push({
      from: food.from,
      to: food.to,
      strength,
      createdAt: now,
    });
    this.lastSnapshotAt = -Infinity;
    return {
      position: {
        x: food.rect.x + food.rect.width / 2,
        y: food.rect.y + food.rect.height / 2,
      },
      strength,
    };
  }

  undoLastBite() {
    undo(this.view);
    this.invalidateDocument();
    this.view.focus();
  }

  private readonly invalidateViewport = () => {
    this.refreshViewport();
  };

  private extractEdibles(now: number) {
    const foods: EdibleCode[] = [];
    const doc = this.view.state.doc;
    const scroll = this.view.scrollDOM;
    const scrollRect = scroll.getBoundingClientRect();
    // Only rendered text has reliable geometry. Never invent offscreen food
    // positions from source columns when lines wrap or contain image tokens.
    const lineNumbers = new Set<number>();
    for (const visible of this.view.visibleRanges) {
      const last = doc.lineAt(visible.to).number;
      for (let number = doc.lineAt(visible.from).number; number <= last; number++) {
        lineNumbers.add(number);
      }
    }
    for (const lineNumber of lineNumbers) {
      const line = doc.line(lineNumber);
      for (const range of this.rangesForLine(line.text, line.from)) {
        if (!this.view.visibleRanges.some((visible) =>
          range.from >= visible.from && range.to <= visible.to
        )) continue;
        const text = doc.sliceString(range.from, range.to);
        if (!text.trim() || isTidalFoodBlacklisted(text, range.kind)) continue;
        const start = this.view.domAtPos(range.from);
        const end = this.view.domAtPos(range.to);
        const domRange = this.view.dom.ownerDocument.createRange();
        domRange.setStart(start.node, start.offset);
        domRange.setEnd(end.node, end.offset);
        // A modifier can span wrapped rows. Aim at its largest real fragment,
        // not the empty space inside a rectangle enclosing multiple rows.
        const fragments = Array.from(domRange.getClientRects())
          .filter((rect) => rect.width > 0 && rect.height > 0);
        const bounds = fragments.sort((a, b) => b.width - a.width)[0];
        if (!bounds) continue;
        const rect: Rect = {
          x: bounds.left - scrollRect.left + scroll.scrollLeft,
          y: bounds.top - scrollRect.top + scroll.scrollTop,
          width: bounds.width,
          height: bounds.height,
        };
        const length = range.to - range.from;
        const heat = this.heatForRange(range.from, range.to, now);
        const kindNutrition = range.kind === "modifier" ? 0.72 : 0.68;
        foods.push({
          id: `${range.from}:${range.to}:${text}`,
          ...range,
          text,
          rect,
          heat,
          nutrition: clamp(kindNutrition + Math.min(0.25, length / 60), 0, 1),
        });
      }
    }

    return foods;
  }

  private rangesForLine(text: string, lineFrom: number) {
    const ranges: CandidateRange[] = [];
    const occupied: Array<{ from: number; to: number }> = [];
    const commentStart = this.commentStart(text);
    const code = commentStart < 0 ? text : text.slice(0, commentStart);

    const addRange = (from: number, to: number, kind: FoodKind) => {
      if (to <= from) return;
      if (occupied.some((range) => from < range.to && to > range.from)) return;
      occupied.push({ from, to });
      ranges.push({ from: lineFrom + from, to: lineFrom + to, kind });
    };

    for (const match of code.matchAll(/(?:^|\s)#\s*[A-Za-z][\w']*\s+-?(?:\d+(?:\.\d*)?|\.\d+)/g)) {
      if (match.index === undefined) continue;
      const leadingSpace = /^\s/.test(match[0]) ? 1 : 0;
      addRange(
        match.index + leadingSpace,
        match.index + match[0].length,
        "modifier"
      );
    }

    const codeWithoutStrings = this.maskStrings(code);
    for (const match of codeWithoutStrings.matchAll(mutableFunctionPattern)) {
      if (match.index === undefined) continue;
      if (!isSafeTidalFunctionContext(match[0], codeWithoutStrings, match.index)) {
        continue;
      }
      addRange(
        match.index,
        match.index + match[0].length,
        "function"
      );
    }

    return ranges.sort((left, right) => left.from - right.from);
  }

  private maskStrings(text: string) {
    let masked = "";
    let insideString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (insideString) {
        masked += " ";
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') insideString = false;
      } else if (character === '"') {
        insideString = true;
        masked += " ";
      } else {
        masked += character;
      }
    }
    return masked;
  }

  private commentStart(text: string) {
    let insideString = false;
    let escaped = false;
    for (let index = 0; index < text.length - 1; index += 1) {
      const character = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\" && insideString) {
        escaped = true;
        continue;
      }
      if (character === '"') {
        insideString = !insideString;
        continue;
      }
      if (!insideString && character === "-" && text[index + 1] === "-") {
        return index;
      }
    }
    return -1;
  }

  private heatForRange(from: number, to: number, now: number) {
    let heat = 0;
    for (const source of this.heatSources) {
      if (source.from >= to || source.to <= from) continue;
      const age = Math.max(0, now - source.createdAt);
      heat += source.strength * Math.pow(0.5, age / 1_800);
    }
    return clamp(heat);
  }
}
