import { countColumn, StateEffect, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import {
  dampedSpringImpulse,
  dampedSpringStep,
} from "@core/animation/spring";

const MORPH_DURATION = 520;
const EMPTY_LINE_COLUMNS = 6;
const CONTOUR_MARGIN = 96;
const SIGNAL_SMOOTHING_RADIUS = 3;
const ENTROPY_EDGE_INFLUENCE = 28;
const MAX_CONTROL_POINTS = 8;
const CURVE_RELAXATION_PASSES = 2;
const BIT_FILTER_SCALE = 1 / 6;
const BIT_LINE_WIDTH = 6;
const BIT_ALPHA_THRESHOLD = 96;
const CONTOUR_BOTTOM_OVERSHOOT = 12;
const MIN_CONTROL_POINT_GAP = 72;
const MAX_CONTROL_POINT_GAP = 180;
const CONTROL_POINT_GAP_RATIO = 0.7;
const BEZIER_HANDLE_RATIO = 0.42;
const CONTOUR_SPRING = { stiffness: 1050, damping: 16.5 };
const CONTOUR_SPRING_BLEND = 0.72;
const LOCAL_REACTION_RADIUS = 110;
const LOCAL_REACTION_AMPLITUDE = 42;
const LOCAL_REACTION_SAMPLE_GAP = 18;
const MAX_LOCAL_REACTIONS = 12;

export interface OrganicContourReactionDetail {
  from: number;
  to: number;
  time: number;
  surprise: number;
  direction: number;
}

export const organicContourReactionEffect =
  StateEffect.define<OrganicContourReactionDetail>();

interface Point {
  x: number;
  y: number;
}

interface CodeLineGeometry extends Point {
  top: number;
  bottom: number;
  codeEdge: number;
  entropy: number;
}

interface SignalPoint extends Point {
  entropy: number;
}

interface ContourMeasurement {
  width: number;
  height: number;
  points: Point[];
  visible: boolean;
}

interface LocalReaction {
  y: number;
  startedAt: number;
  intensity: number;
  direction: number;
}

interface CubicSegment {
  start: Point;
  firstControl: Point;
  secondControl: Point;
  end: Point;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function cssPixels(value: string | undefined) {
  const parsed = Number.parseFloat(value ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

function codeLineRange(view: EditorView) {
  const { doc } = view.state;
  let first = 1;
  let last = doc.lines;

  while (first <= last && doc.line(first).text.trim().length === 0) first += 1;
  while (last >= first && doc.line(last).text.trim().length === 0) last -= 1;

  return first <= last ? { first, last } : null;
}

function lineEntropy(text: string) {
  const symbols = [...text.replace(/\s/g, "")];
  if (symbols.length < 2) return 0;

  const frequencies = new Map<string, number>();
  for (const symbol of symbols) {
    frequencies.set(symbol, (frequencies.get(symbol) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / symbols.length;
    entropy -= probability * Math.log2(probability);
  }

  const maximumEntropy = Math.log2(Math.min(symbols.length, 64));
  return clamp(entropy / Math.max(1, maximumEntropy), 0, 1);
}

function smoothedSignal(
  lines: CodeLineGeometry[],
  margin: number,
  maximumX: number
) {
  const signal = lines.map((line, index): SignalPoint => {
    let weightedEdge = 0;
    let totalWeight = 0;
    const first = Math.max(0, index - SIGNAL_SMOOTHING_RADIUS);
    const last = Math.min(lines.length - 1, index + SIGNAL_SMOOTHING_RADIUS);

    for (let neighbor = first; neighbor <= last; neighbor += 1) {
      const distance = Math.abs(neighbor - index);
      const weight = SIGNAL_SMOOTHING_RADIUS + 1 - distance;
      const neighborLine = lines[neighbor];
      weightedEdge +=
        (neighborLine.codeEdge +
          neighborLine.entropy * ENTROPY_EDGE_INFLUENCE) *
        weight;
      totalWeight += weight;
    }

    const averageEdge = weightedEdge / totalWeight;
    return {
      x: clamp(
        Math.max(line.codeEdge + margin * 0.55, averageEdge + margin),
        12,
        maximumX
      ),
      y: line.y,
      entropy: line.entropy,
    };
  });

  signal.unshift({
    x: signal[0].x,
    y: lines[0].top,
    entropy: signal[0].entropy,
  });
  signal.push({
    x: signal[signal.length - 1].x,
    y: lines[lines.length - 1].bottom,
    entropy: signal[signal.length - 1].entropy,
  });
  return signal;
}

function normalizedCurvatureEntropy(signal: SignalPoint[]) {
  const curvature: number[] = [];
  for (let index = 1; index < signal.length - 1; index += 1) {
    curvature.push(
      Math.abs(signal[index + 1].x - signal[index].x * 2 + signal[index - 1].x)
    );
  }

  const total = curvature.reduce((sum, value) => sum + value, 0);
  if (total <= 0 || curvature.length < 2) return 0;

  let entropy = 0;
  for (const value of curvature) {
    if (value <= 0) continue;
    const probability = value / total;
    entropy -= probability * Math.log2(probability);
  }
  return clamp(entropy / Math.log2(curvature.length), 0, 1);
}

function bestInformationSplit(
  signal: SignalPoint[],
  start: number,
  end: number,
  minimumGap: number
) {
  if (end - start < 2) return null;

  const first = signal[start];
  const last = signal[end];
  const height = Math.max(1, last.y - first.y);
  let bestIndex = -1;
  let bestGain = 0;

  for (let index = start + 1; index < end; index += 1) {
    if (
      signal[index].y - first.y < minimumGap ||
      last.y - signal[index].y < minimumGap
    ) {
      continue;
    }

    const progress = (signal[index].y - first.y) / height;
    const reconstructedX = first.x + (last.x - first.x) * progress;
    const residual = Math.abs(signal[index].x - reconstructedX);
    const informationGain = residual * (0.85 + signal[index].entropy * 0.3);
    if (informationGain > bestGain) {
      bestGain = informationGain;
      bestIndex = index;
    }
  }

  return bestIndex < 0 ? null : { index: bestIndex, gain: bestGain };
}

function entropySimplifiedContour(signal: SignalPoint[]) {
  if (signal.length <= 2) return signal;

  const xs = signal.map(({ x }) => x);
  const amplitude = Math.max(...xs) - Math.min(...xs);
  const entropy = normalizedCurvatureEntropy(signal);
  const tolerance = clamp(amplitude * (0.22 - entropy * 0.08), 26, 64);
  const totalHeight = Math.max(1, signal[signal.length - 1].y - signal[0].y);
  const minimumGap = clamp(
    (totalHeight / Math.max(1, MAX_CONTROL_POINTS - 1)) *
      CONTROL_POINT_GAP_RATIO,
    MIN_CONTROL_POINT_GAP,
    MAX_CONTROL_POINT_GAP
  );
  const selected = [0, signal.length - 1];

  while (selected.length < MAX_CONTROL_POINTS) {
    selected.sort((left, right) => left - right);
    let best: { index: number; gain: number } | null = null;

    for (let segment = 0; segment < selected.length - 1; segment += 1) {
      const candidate = bestInformationSplit(
        signal,
        selected[segment],
        selected[segment + 1],
        minimumGap
      );
      if (candidate && (!best || candidate.gain > best.gain)) best = candidate;
    }

    if (!best || best.gain <= tolerance) break;
    selected.push(best.index);
  }

  return selected
    .sort((left, right) => left - right)
    .map((index) => signal[index]);
}

function relaxedCurve(points: Point[]) {
  if (points.length < 3) return points.map((point) => ({ ...point }));

  let relaxed = points.map((point) => ({ ...point }));
  for (let pass = 0; pass < CURVE_RELAXATION_PASSES; pass += 1) {
    relaxed = relaxed.map((point, index, current) => {
      if (index === 0 || index === current.length - 1) return { ...point };

      const previous = current[index - 1];
      const next = current[index + 1];
      const span = Math.max(1, next.y - previous.y);
      const progress = clamp((point.y - previous.y) / span, 0, 1);
      const neighborTrend = previous.x + (next.x - previous.x) * progress;

      return {
        x: point.x * 0.82 + neighborTrend * 0.18,
        y: point.y,
      };
    });
  }

  return relaxed;
}

function extendCurveToBottom(
  points: Point[],
  bottom: number,
  maximumX: number
) {
  if (points.length === 0) return points;

  const extended = points.map((point) => ({ ...point }));
  const last = extended[extended.length - 1];
  if (bottom <= last.y) return extended;

  const previous = extended[Math.max(0, extended.length - 2)];
  const previousHeight = Math.max(1, last.y - previous.y);
  const outgoingSlope = clamp(
    (last.x - previous.x) / previousHeight,
    -0.35,
    0.35
  );
  const extensionHeight = bottom - last.y;
  extended.push({
    x: clamp(last.x + outgoingSlope * extensionHeight * 0.35, 12, maximumX),
    y: bottom,
  });
  return extended;
}

function measureContour(view: EditorView): ContourMeasurement {
  const scroller = view.scrollDOM;
  const scrollerRect = scroller.getBoundingClientRect();
  const contentRect = view.contentDOM.getBoundingClientRect();
  const scaleX = view.scaleX || 1;
  const scaleY = view.scaleY || 1;
  const contentLeft =
    (contentRect.left - scrollerRect.left) / scaleX + scroller.scrollLeft;
  const contentTop =
    (contentRect.top - scrollerRect.top) / scaleY + scroller.scrollTop;
  const documentTop =
    (view.documentTop - scrollerRect.top) / scaleY + scroller.scrollTop;
  const width = Math.max(scroller.clientWidth, view.contentDOM.scrollWidth);
  const height = Math.max(
    scroller.clientHeight,
    contentTop + view.contentHeight
  );
  const range = codeLineRange(view);

  if (!range) return { width, height, points: [], visible: false };

  const probe = view.contentDOM.querySelector<HTMLElement>(".cm-line");
  const probeStyle = probe ? getComputedStyle(probe) : undefined;
  const paddingLeft = cssPixels(probeStyle?.paddingLeft);
  const paddingRight = cssPixels(probeStyle?.paddingRight);
  const characterWidth = Math.max(1, view.defaultCharacterWidth);
  const contourMargin = Math.max(CONTOUR_MARGIN, characterWidth * 7);
  const emptyLineRight =
    contentLeft +
    paddingLeft +
    EMPTY_LINE_COLUMNS * characterWidth +
    paddingRight;
  const lines: CodeLineGeometry[] = [];

  for (
    let lineNumber = range.first;
    lineNumber <= range.last;
    lineNumber += 1
  ) {
    const line = view.state.doc.line(lineNumber);
    const block = view.lineBlockAt(line.from);
    const top = documentTop + block.top;
    const bottom = top + block.height;
    const text = line.text.trimEnd();
    const fallbackRight =
      contentLeft +
      paddingLeft +
      countColumn(text, view.state.tabSize) * characterWidth +
      paddingRight;
    const codeEdge =
      text.trim().length === 0
        ? emptyLineRight
        : fallbackRight;
    const entropy = lineEntropy(text);

    lines.push({
      x: codeEdge,
      y: (top + bottom) / 2,
      top,
      bottom,
      codeEdge,
      entropy,
    });
  }

  const signal = smoothedSignal(
    lines,
    contourMargin,
    Math.max(12, width - 12)
  );
  const points = extendCurveToBottom(
    relaxedCurve(entropySimplifiedContour(signal)),
    height + CONTOUR_BOTTOM_OVERSHOOT,
    Math.max(12, width - 12)
  );

  return {
    // The decorative canvas must not expand the editor's scrollable width.
    width,
    height,
    points,
    visible: true,
  };
}

function documentYAtPosition(view: EditorView, position: number) {
  const scroller = view.scrollDOM;
  const scrollerRect = scroller.getBoundingClientRect();
  const scaleY = view.scaleY || 1;
  const documentTop =
    (view.documentTop - scrollerRect.top) / scaleY + scroller.scrollTop;
  const safePosition = clamp(position, 0, view.state.doc.length);
  const block = view.lineBlockAt(safePosition);
  return documentTop + block.top + block.height / 2;
}

function monotoneSlopes(points: Point[]) {
  if (points.length < 2) return points.map(() => 0);

  const deltas = points.slice(0, -1).map((point, index) => {
    const next = points[index + 1];
    return (next.x - point.x) / Math.max(1, next.y - point.y);
  });
  const slopes = points.map(() => 0);
  slopes[0] = deltas[0];
  slopes[slopes.length - 1] = deltas[deltas.length - 1];

  for (let index = 1; index < slopes.length - 1; index += 1) {
    const before = deltas[index - 1];
    const after = deltas[index];
    if (before * after <= 0) continue;

    const beforeHeight = Math.max(1, points[index].y - points[index - 1].y);
    const afterHeight = Math.max(1, points[index + 1].y - points[index].y);
    const beforeWeight = beforeHeight + afterHeight * 2;
    const afterWeight = beforeHeight * 2 + afterHeight;
    slopes[index] =
      (beforeWeight + afterWeight) /
      (beforeWeight / before + afterWeight / after);
  }

  // Fritsch-Carlson limiting keeps every Bézier segment inside the range of
  // its endpoints, avoiding the tight hooks produced by overshooting handles.
  for (let index = 0; index < deltas.length; index += 1) {
    const delta = deltas[index];
    if (Math.abs(delta) < 0.0001) {
      slopes[index] = 0;
      slopes[index + 1] = 0;
      continue;
    }

    const alpha = slopes[index] / delta;
    const beta = slopes[index + 1] / delta;
    const magnitude = Math.hypot(alpha, beta);
    if (magnitude <= 3) continue;

    const factor = 3 / magnitude;
    slopes[index] = factor * alpha * delta;
    slopes[index + 1] = factor * beta * delta;
  }

  return slopes;
}

function contourSegments(points: Point[]) {
  if (points.length < 2) return [];

  const slopes = monotoneSlopes(points);
  return points.slice(0, -1).map((current, index): CubicSegment => {
    const next = points[index + 1];
    const handleHeight =
      Math.max(1, next.y - current.y) * BEZIER_HANDLE_RATIO;

    return {
      start: current,
      firstControl: {
        x: current.x + slopes[index] * handleHeight,
        y: current.y + handleHeight,
      },
      secondControl: {
        x: next.x - slopes[index + 1] * handleHeight,
        y: next.y - handleHeight,
      },
      end: next,
    };
  });
}

function contourPath(points: Point[]) {
  const path = new Path2D();
  if (points.length === 0) return path;

  path.moveTo(points[0].x, points[0].y);
  for (const segment of contourSegments(points)) {
    path.bezierCurveTo(
      segment.firstControl.x,
      segment.firstControl.y,
      segment.secondControl.x,
      segment.secondControl.y,
      segment.end.x,
      segment.end.y
    );
  }
  return path;
}

function cubicValue(
  start: number,
  firstControl: number,
  secondControl: number,
  end: number,
  progress: number
) {
  const remaining = 1 - progress;
  return (
    remaining ** 3 * start +
    3 * remaining ** 2 * progress * firstControl +
    3 * remaining * progress ** 2 * secondControl +
    progress ** 3 * end
  );
}

function pointOnSegment(segment: CubicSegment, progress: number): Point {
  return {
    x: cubicValue(
      segment.start.x,
      segment.firstControl.x,
      segment.secondControl.x,
      segment.end.x,
      progress
    ),
    y: cubicValue(
      segment.start.y,
      segment.firstControl.y,
      segment.secondControl.y,
      segment.end.y,
      progress
    ),
  };
}

function pointOnContourAtY(
  points: Point[],
  segments: CubicSegment[],
  y: number
) {
  if (points.length === 0) return { x: 0, y };
  if (segments.length === 0) return { x: points[0].x, y };

  const segment =
    segments.find(({ end }) => y <= end.y) ?? segments[segments.length - 1];
  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const middle = (lower + upper) / 2;
    if (pointOnSegment(segment, middle).y < y) lower = middle;
    else upper = middle;
  }

  const point = pointOnSegment(segment, (lower + upper) / 2);
  return { x: point.x, y };
}

function locallyReactingPoints(
  points: Point[],
  reactions: LocalReaction[],
  now: number
) {
  if (points.length < 2 || reactions.length === 0) return points;

  const motions = reactions
    .map((reaction) => ({
      ...reaction,
      displacement:
        dampedSpringImpulse(now - reaction.startedAt, CONTOUR_SPRING)
          .displacement *
        reaction.intensity *
        reaction.direction,
    }))
    .filter(({ startedAt }) => now - startedAt < MORPH_DURATION);
  if (motions.length === 0) return points;

  const firstY = points[0].y;
  const lastY = points[points.length - 1].y;
  const sampleYs = points.map(({ y }) => y);
  for (const reaction of motions) {
    for (const offset of [-1.5, -0.75, 0, 0.75, 1.5]) {
      sampleYs.push(
        clamp(
          reaction.y + LOCAL_REACTION_RADIUS * offset,
          firstY,
          lastY
        )
      );
    }
  }
  sampleYs.sort((left, right) => left - right);

  const spacedSampleYs: number[] = [];
  for (const y of sampleYs) {
    const previous = spacedSampleYs[spacedSampleYs.length - 1];
    if (previous === undefined || y - previous >= LOCAL_REACTION_SAMPLE_GAP) {
      spacedSampleYs.push(y);
    } else if (y === lastY) {
      spacedSampleYs[spacedSampleYs.length - 1] = y;
    }
  }

  const segments = contourSegments(points);
  return spacedSampleYs.map((y) => {
    const point = pointOnContourAtY(points, segments, y);
    let displacement = 0;
    for (const reaction of motions) {
      const distance = (y - reaction.y) / (LOCAL_REACTION_RADIUS * 0.55);
      const spatialWeight = Math.exp(-0.5 * distance * distance);
      displacement +=
        reaction.displacement * LOCAL_REACTION_AMPLITUDE * spatialWeight;
    }
    return {
      x: point.x + clamp(displacement, -48, 48),
      y,
    };
  });
}

function hardenPixels(
  context: CanvasRenderingContext2D,
  width: number,
  height: number
) {
  const image = context.getImageData(0, 0, width, height);
  const { data } = image;

  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] < BIT_ALPHA_THRESHOLD) {
      data[index + 3] = 0;
      continue;
    }

    data[index] = 255;
    data[index + 1] = 255;
    data[index + 2] = 255;
    data[index + 3] = 255;
  }

  context.putImageData(image, 0, 0);
}

function interpolatePoints(from: Point[], to: Point[], progress: number) {
  return to.map((point, index) => ({
    x: from[index].x + (point.x - from[index].x) * progress,
    y: from[index].y + (point.y - from[index].y) * progress,
  }));
}

function resamplePoints(points: Point[], count: number) {
  if (points.length === 0 || count <= 0) return [];
  if (points.length === count) {
    return points.map((point) => ({ ...point }));
  }
  if (points.length === 1) {
    return Array.from({ length: count }, () => ({ ...points[0] }));
  }

  const first = points[0];
  const last = points[points.length - 1];
  const totalHeight = Math.max(1, last.y - first.y);
  let segment = 0;

  return Array.from({ length: count }, (_, index) => {
    const progress = count === 1 ? 0 : index / (count - 1);
    const targetY = first.y + totalHeight * progress;
    while (
      segment < points.length - 2 &&
      points[segment + 1].y < targetY
    ) {
      segment += 1;
    }

    const before = points[segment];
    const after = points[segment + 1];
    const segmentHeight = Math.max(1, after.y - before.y);
    const segmentProgress = clamp((targetY - before.y) / segmentHeight, 0, 1);
    return {
      x: before.x + (after.x - before.x) * segmentProgress,
      y: targetY,
    };
  });
}

function samePoints(left: Point[], right: Point[]) {
  return (
    left.length === right.length &&
    left.every(
      (point, index) =>
        Math.abs(point.x - right[index].x) < 0.1 &&
        Math.abs(point.y - right[index].y) < 0.1
    )
  );
}

const organicContourTheme = EditorView.baseTheme({
  ".cm-scroller > .cm-organic-code-contour": {
    position: "absolute",
    top: "0",
    left: "0",
    zIndex: "0",
    overflow: "hidden",
    pointerEvents: "none",
    userSelect: "none",
    imageRendering: "pixelated",
    opacity: "1",
  },
  ".cm-scroller > .cm-content": {
    position: "relative",
    zIndex: "1",
  },
  ".cm-scroller > .cm-layer": {
    zIndex: "2",
  },
});

class OrganicCodeContour {
  private readonly surface = document.createElement("canvas");
  private readonly context: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private readonly reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  private currentPoints: Point[] = [];
  private targetPoints: Point[] = [];
  private localReactions: LocalReaction[] = [];
  private animationFrame = 0;
  private reactionAnimationFrame = 0;
  private destroyed = false;

  private readonly measureRequest = {
    read: (): ContourMeasurement => measureContour(this.view),
    write: (measurement: ContourMeasurement) => this.draw(measurement),
  };

  constructor(private readonly view: EditorView) {
    const context = this.surface.getContext("2d");
    if (!context) throw new Error("Organic contour canvas is unavailable");
    this.context = context;
    this.surface.className = "cm-organic-code-contour";
    this.surface.setAttribute("aria-hidden", "true");
    this.view.scrollDOM.insertBefore(this.surface, this.view.contentDOM);
    this.resizeObserver = new ResizeObserver(this.schedule);
    this.resizeObserver.observe(this.view.scrollDOM);
    this.resizeObserver.observe(this.view.contentDOM);
    this.view.dom.addEventListener("pointerdown", this.redraw, {
      capture: true,
      passive: true,
    });
    this.reducedMotion.addEventListener("change", this.motionPreferenceChanged);
    this.schedule();
  }

  update(update: ViewUpdate) {
    for (const transaction of update.transactions) {
      for (const effect of transaction.effects) {
        if (effect.is(organicContourReactionEffect)) {
          this.reactToHighlight(effect.value);
        }
      }
    }

    if (
      update.docChanged ||
      (update.geometryChanged && !update.viewportChanged)
    ) {
      this.schedule();
    } else if (update.selectionSet || update.focusChanged) {
      this.redraw();
    }
  }

  destroy() {
    this.destroyed = true;
    this.resizeObserver.disconnect();
    this.view.dom.removeEventListener("pointerdown", this.redraw, true);
    this.reducedMotion.removeEventListener("change", this.motionPreferenceChanged);
    cancelAnimationFrame(this.animationFrame);
    cancelAnimationFrame(this.reactionAnimationFrame);
    this.surface.remove();
  }

  private readonly schedule = () => {
    if (!this.destroyed) this.view.requestMeasure(this.measureRequest);
  };

  private readonly redraw = () => {
    if (!this.destroyed) this.render(this.currentPoints);
  };

  private reactToHighlight(detail: OrganicContourReactionDetail) {
    if (this.destroyed || this.reducedMotion.matches) return;
    if (
      !detail ||
      !Number.isFinite(detail.from) ||
      !Number.isFinite(detail.to)
    ) {
      return;
    }

    const center = Math.round((detail.from + detail.to) / 2);
    const now = performance.now();
    this.localReactions = [
      ...this.localReactions.filter(
        ({ startedAt }) => now - startedAt < MORPH_DURATION
      ),
      {
        y: documentYAtPosition(this.view, center),
        startedAt: Number.isFinite(detail.time) ? detail.time : now,
        intensity:
          0.4 + Math.pow(clamp(detail.surprise, 0, 1), 1.1) * 0.6,
        direction: detail.direction < 0 ? -1 : 1,
      },
    ].slice(-MAX_LOCAL_REACTIONS);

    if (this.reactionAnimationFrame === 0) {
      this.reactionAnimationFrame = requestAnimationFrame(
        this.animateLocalReactions
      );
    }
  }

  private readonly animateLocalReactions = (now: number) => {
    this.reactionAnimationFrame = 0;
    if (this.destroyed) return;
    this.localReactions = this.localReactions.filter(
      ({ startedAt }) => now - startedAt < MORPH_DURATION
    );
    this.render(this.currentPoints, now);
    if (this.localReactions.length > 0) {
      this.reactionAnimationFrame = requestAnimationFrame(
        this.animateLocalReactions
      );
    }
  };

  private readonly motionPreferenceChanged = () => {
    if (!this.reducedMotion.matches) return;
    cancelAnimationFrame(this.animationFrame);
    cancelAnimationFrame(this.reactionAnimationFrame);
    this.animationFrame = 0;
    this.reactionAnimationFrame = 0;
    this.localReactions = [];
    if (this.targetPoints.length === 0) return;
    this.currentPoints = this.targetPoints.map((point) => ({ ...point }));
    this.render(this.currentPoints);
  };

  private draw({ width, height, points, visible }: ContourMeasurement) {
    if (this.destroyed || width <= 0 || height <= 0) return;

    const bitmapWidth = Math.max(1, Math.ceil(width * BIT_FILTER_SCALE));
    const bitmapHeight = Math.max(1, Math.ceil(height * BIT_FILTER_SCALE));
    if (this.surface.width !== bitmapWidth) this.surface.width = bitmapWidth;
    if (this.surface.height !== bitmapHeight) this.surface.height = bitmapHeight;
    this.surface.style.width = `${width}px`;
    this.surface.style.height = `${height}px`;
    this.surface.style.visibility = visible ? "visible" : "hidden";

    if (!visible) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
      this.currentPoints = [];
      this.targetPoints = [];
      this.localReactions = [];
      cancelAnimationFrame(this.reactionAnimationFrame);
      this.reactionAnimationFrame = 0;
      this.render([]);
      return;
    }

    if (samePoints(points, this.targetPoints)) {
      this.render(this.currentPoints);
      return;
    }
    this.targetPoints = points.map((point) => ({ ...point }));

    if (this.currentPoints.length === 0 || this.reducedMotion.matches) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
      this.currentPoints = points.map((point) => ({ ...point }));
      this.render(this.currentPoints);
      return;
    }

    this.morphTo(points);
  }

  private morphTo(points: Point[]) {
    cancelAnimationFrame(this.animationFrame);
    const pointCount = Math.max(this.currentPoints.length, points.length);
    const from = resamplePoints(this.currentPoints, pointCount);
    const to = resamplePoints(points, pointCount);
    const startedAt = performance.now();

    const tick = (now: number) => {
      this.animationFrame = 0;
      if (this.destroyed) return;
      const elapsedMs = Math.max(0, now - startedAt);
      const elapsed = clamp(elapsedMs / MORPH_DURATION, 0, 1);
      if (elapsed >= 1) {
        this.currentPoints = points.map((point) => ({ ...point }));
        this.render(this.currentPoints);
        return;
      }

      const eased = 1 - Math.pow(1 - elapsed, 3);
      const spring = dampedSpringStep(elapsedMs, CONTOUR_SPRING);
      const springProgress =
        eased + (spring - eased) * CONTOUR_SPRING_BLEND;
      this.currentPoints = interpolatePoints(from, to, springProgress);
      this.render(this.currentPoints);
      this.animationFrame = requestAnimationFrame(tick);
    };

    this.animationFrame = requestAnimationFrame(tick);
  }

  private render(points: Point[], now = performance.now()) {
    const path = contourPath(
      locallyReactingPoints(points, this.localReactions, now)
    );
    const context = this.context;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.surface.width, this.surface.height);
    if (points.length === 0) return;

    // Draw the smooth Bézier first, then hard-threshold its low-resolution
    // pixels. Nearest-neighbor enlargement preserves the resulting jagged edge.
    context.setTransform(
      BIT_FILTER_SCALE,
      0,
      0,
      BIT_FILTER_SCALE,
      0,
      0
    );
    context.imageSmoothingEnabled = false;
    context.filter = "none";
    context.globalAlpha = 1;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#ffffff";
    context.lineWidth = BIT_LINE_WIDTH;
    context.stroke(path);

    context.setTransform(1, 0, 0, 1, 0, 0);
    hardenPixels(context, this.surface.width, this.surface.height);
  }
}

const organicContourPlugin = ViewPlugin.fromClass(OrganicCodeContour);

export const organicCodeContour: Extension = [
  organicContourTheme,
  organicContourPlugin,
];
