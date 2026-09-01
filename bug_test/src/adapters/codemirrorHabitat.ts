import { undo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";

import { clamp, type Rect, type Vec2 } from "../bug/math";
import type {
  EdibleCode,
  EatenMatter,
  FoodKind,
  HabitatAdapter,
  HabitatSnapshot,
} from "../bug/types";

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

export class CodeMirrorHabitat implements HabitatAdapter {
  private readonly heatSources: HeatSource[] = [];
  private lastSnapshot: HabitatSnapshot | null = null;
  private lastSnapshotAt = -Infinity;
  private revision = 0;
  private snapshotRevision = -1;

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
      contentX + this.view.state.doc.length * this.view.defaultCharacterWidth * 0.03
    );
    const worldHeight = Math.max(
      scroll.clientHeight,
      this.view.contentHeight + this.view.defaultLineHeight * 2
    );

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
      edibles: this.extractEdibles(now, contentX),
    };
    this.lastSnapshot = snapshot;
    this.lastSnapshotAt = now;
    this.snapshotRevision = this.revision;
    return snapshot;
  }

  stageToWorld(point: Vec2): Vec2 {
    const snapshot = this.snapshot(performance.now());
    return {
      x: point.x - snapshot.canvasOffsetX + snapshot.scrollX,
      y: point.y - snapshot.canvasOffsetY + snapshot.scrollY,
    };
  }

  eat(edible: EdibleCode): EatenMatter | null {
    const current = this.view.state.doc.sliceString(edible.from, edible.to);
    if (current !== edible.text) return null;
    const line = this.view.state.doc.lineAt(edible.from);
    const matter: EatenMatter = {
      id: `${Date.now().toString(36)}-${edible.id}`,
      text: current,
      kind: edible.kind,
      nutrition: edible.nutrition,
      lineNumber: line.number,
      column: edible.from - line.from,
    };
    this.view.dispatch({
      changes: { from: edible.from, to: edible.to, insert: "" },
    });
    this.invalidateDocument();
    return matter;
  }

  restore(matter: EatenMatter) {
    const lineNumber = clamp(
      matter.lineNumber,
      1,
      this.view.state.doc.lines
    );
    const line = this.view.state.doc.line(lineNumber);
    const position = line.from + clamp(matter.column, 0, line.length);
    this.view.dispatch({
      changes: { from: position, insert: matter.text },
      selection: { anchor: position + matter.text.length },
    });
    this.invalidateDocument();
    this.view.focus();
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
    this.lastSnapshotAt = -Infinity;
  };

  private extractEdibles(now: number, contentX: number) {
    const foods: EdibleCode[] = [];
    const doc = this.view.state.doc;
    const characterWidth = this.view.defaultCharacterWidth;
    const lineHeight = this.view.defaultLineHeight;

    for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
      const line = doc.line(lineNumber);
      const ranges = this.rangesForLine(line.text, line.from);
      const lineBlock = this.view.lineBlockAt(line.from);

      for (const range of ranges) {
        const text = doc.sliceString(range.from, range.to);
        if (text.trim().length === 0) continue;
        const startColumn = range.from - line.from;
        const length = Math.max(1, range.to - range.from);
        const rect: Rect = {
          x: contentX + startColumn * characterWidth,
          y: lineBlock.top + lineHeight * 0.08,
          width: Math.max(characterWidth * 0.8, length * characterWidth),
          height: lineHeight * 0.84,
        };
        const heat = this.heatForRange(range.from, range.to, now);
        const kindNutrition =
          range.kind === "comment" ? 0.85 : range.kind === "modifier" ? 0.72 : 0.58;
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

    const addRange = (from: number, to: number, kind: FoodKind) => {
      if (to <= from) return;
      if (occupied.some((range) => from < range.to && to > range.from)) return;
      occupied.push({ from, to });
      ranges.push({ from: lineFrom + from, to: lineFrom + to, kind });
    };

    for (const match of text.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)) {
      if (match.index === undefined) continue;
      const inner = match[1];
      const innerOffset = match.index + 1;
      for (const token of inner.matchAll(/[A-Za-z][\w-]*(?::-?\d+)?(?:\*\d+)?/g)) {
        if (token.index === undefined) continue;
        addRange(
          innerOffset + token.index,
          innerOffset + token.index + token[0].length,
          "mini"
        );
      }
    }

    for (const match of text.matchAll(/(?:^|\s)#\s*[A-Za-z][\w']*\s+-?(?:\d+(?:\.\d*)?|\.\d+)/g)) {
      if (match.index === undefined) continue;
      const leadingSpace = /^\s/.test(match[0]) ? 1 : 0;
      addRange(
        match.index + leadingSpace,
        match.index + match[0].length,
        "modifier"
      );
    }

    const comment = text.match(/--.+$/);
    if (comment?.index !== undefined) {
      addRange(comment.index, text.length, "comment");
    }

    return ranges.sort((left, right) => left.from - right.from);
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
