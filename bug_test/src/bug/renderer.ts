import { CaterpillarBody, MAX_TURN_RATE } from "./body";
import {
  centerOf,
  clamp,
  distance,
  lerp,
  normalize,
  type Vec2,
} from "./math";
import type {
  Behaviour,
  EdibleCode,
  EatenMatter,
  HabitatSnapshot,
} from "./types";
import bugFaceUrl from "../assets/bug-face.png";

// Keep landing targets in the simulation, but hide their + debug glyphs.
// Flip this during gait tuning without changing any locomotion state.
const DEBUG_SHOW_LANDING_TARGETS = false;
const SHOW_FOOD_ROUTE = false;
const SHOW_LOCOMOTION_GUIDE = false;
const CREATURE_PIXEL_SCALE = 1 / 3;
const CREATURE_ALPHA_THRESHOLD = 72;
const MESSAGE_PIXEL_SCALE = 1 / 3;
const MESSAGE_ALPHA_THRESHOLD = 88;

interface CreatureBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function staticNoise(seed: number) {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function traceWobblyCircle(
  context: CanvasRenderingContext2D,
  centre: Vec2,
  radius: number,
  seed: number,
  irregularity = 0.045
) {
  const steps = 20;
  context.beginPath();
  for (let index = 0; index <= steps; index += 1) {
    const sample = index % steps;
    const angle = (sample / steps) * Math.PI * 2;
    const wobble = 1 + (staticNoise(seed * 31 + sample) - 0.5) * irregularity;
    const point = {
      x: centre.x + Math.cos(angle) * radius * wobble,
      y: centre.y + Math.sin(angle) * radius * wobble,
    };
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  }
  context.closePath();
}

function hardenCreaturePixels(
  context: CanvasRenderingContext2D,
  width: number,
  height: number
) {
  const image = context.getImageData(0, 0, width, height);
  const { data } = image;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] < CREATURE_ALPHA_THRESHOLD) {
      data[index + 3] = 0;
      continue;
    }

    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const yellowInk = red > 180 && green > 155 && blue < 130;
    const luminance = (red + green + blue) / 3;
    if (yellowInk) {
      data[index] = 255;
      data[index + 1] = 242;
      data[index + 2] = 72;
    } else {
      const value = luminance < 205 ? 0 : 255;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
    }
    data[index + 3] = 255;
  }
  context.putImageData(image, 0, 0);
}

function hardenMessagePixels(
  context: CanvasRenderingContext2D,
  width: number,
  height: number
) {
  const image = context.getImageData(0, 0, width, height);
  const { data } = image;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] < MESSAGE_ALPHA_THRESHOLD) {
      data[index + 3] = 0;
      continue;
    }
    data[index] = Math.round(data[index] / 51) * 51;
    data[index + 1] = Math.round(data[index + 1] / 51) * 51;
    data[index + 2] = Math.round(data[index + 2] / 51) * 51;
    data[index + 3] = 255;
  }
  context.putImageData(image, 0, 0);
}

function traceMessageCloud(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number
) {
  context.beginPath();
  context.moveTo(x + width * 0.17, y + height * 0.78);
  context.bezierCurveTo(
    x - width * 0.02,
    y + height * 0.75,
    x - width * 0.01,
    y + height * 0.48,
    x + width * 0.16,
    y + height * 0.46
  );
  context.bezierCurveTo(
    x + width * 0.08,
    y + height * 0.24,
    x + width * 0.31,
    y + height * 0.1,
    x + width * 0.43,
    y + height * 0.27
  );
  context.bezierCurveTo(
    x + width * 0.5,
    y - height * 0.03,
    x + width * 0.79,
    y + height * 0.01,
    x + width * 0.78,
    y + height * 0.29
  );
  context.bezierCurveTo(
    x + width * 1.02,
    y + height * 0.21,
    x + width * 1.08,
    y + height * 0.54,
    x + width * 0.9,
    y + height * 0.63
  );
  context.bezierCurveTo(
    x + width * 1.02,
    y + height * 0.86,
    x + width * 0.75,
    y + height * 1.01,
    x + width * 0.65,
    y + height * 0.84
  );
  context.bezierCurveTo(
    x + width * 0.51,
    y + height * 1.04,
    x + width * 0.29,
    y + height * 0.99,
    x + width * 0.29,
    y + height * 0.82
  );
  context.bezierCurveTo(
    x + width * 0.23,
    y + height * 0.93,
    x + width * 0.09,
    y + height * 0.91,
    x + width * 0.17,
    y + height * 0.78
  );
  context.closePath();
}

export interface Dropping {
  id: string;
  origin: Vec2;
  position: Vec2;
  matter: EatenMatter | null;
  age: number;
  size: number;
  rotation: number;
}

export interface SoundPulseVisual {
  position: Vec2;
  age: number;
  strength: number;
}

export interface RenderState {
  body: CaterpillarBody;
  bodies: readonly CaterpillarBody[];
  behaviour: Behaviour;
  snapshot: HabitatSnapshot;
  targetFood: EdibleCode | null;
  chewAmount: number;
  faceBubble: "🎵" | "💨" | "💢" | null;
  droppings: Dropping[];
  hoveredDropping: Dropping | null;
  pulses: SoundPulseVisual[];
  hatching: number;
  now: number;
  interpolation: number;
}

export class BugRenderer {
  private readonly context: CanvasRenderingContext2D;
  private readonly creatureSurface = document.createElement("canvas");
  private readonly creatureContext: CanvasRenderingContext2D;
  private readonly messageSurface = document.createElement("canvas");
  private readonly messageContext: CanvasRenderingContext2D;
  private readonly faceImage = new Image();
  private pixelRatio = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable");
    this.context = context;
    const creatureContext = this.creatureSurface.getContext("2d");
    if (!creatureContext) throw new Error("Creature canvas is unavailable");
    this.creatureContext = creatureContext;
    const messageContext = this.messageSurface.getContext("2d");
    if (!messageContext) throw new Error("Message canvas is unavailable");
    this.messageContext = messageContext;
    this.faceImage.decoding = "async";
    this.faceImage.src = bugFaceUrl;
  }

  render(state: RenderState) {
    this.resize();
    const context = this.context;
    const { snapshot } = state;
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    context.clearRect(0, 0, this.canvas.width / this.pixelRatio, this.canvas.height / this.pixelRatio);
    context.save();
    context.translate(
      snapshot.canvasOffsetX - snapshot.scrollX,
      snapshot.canvasOffsetY - snapshot.scrollY
    );

    this.drawPulses(state.pulses);
    if (SHOW_FOOD_ROUTE) this.drawTarget(state);
    this.drawDroppings(state.droppings);
    if (SHOW_LOCOMOTION_GUIDE || DEBUG_SHOW_LANDING_TARGETS) {
      this.drawLocomotionPlan(state);
    }

    context.restore();
    for (const body of state.bodies) this.drawPixelatedCreature(state, body);
    if (state.faceBubble) {
      context.save();
      context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
      context.translate(
        snapshot.canvasOffsetX - snapshot.scrollX,
        snapshot.canvasOffsetY - snapshot.scrollY
      );
      this.drawFaceBubble(state, state.faceBubble);
      context.restore();
    }
    if (state.hoveredDropping) {
      context.save();
      context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
      context.translate(
        snapshot.canvasOffsetX - snapshot.scrollX,
        snapshot.canvasOffsetY - snapshot.scrollY
      );
      this.drawDroppingTooltip(state.hoveredDropping, snapshot);
      context.restore();
    }
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.pixelRatio = ratio;
  }

  private drawPulses(pulses: SoundPulseVisual[]) {
    const context = this.context;
    for (const pulse of pulses) {
      const progress = clamp(pulse.age / 0.78);
      const radius = lerp(8, 76 + pulse.strength * 30, progress);
      context.save();
      context.globalAlpha = (1 - progress) * 0.7;
      context.strokeStyle = "#000000";
      context.lineWidth = 2 + (1 - progress) * 3;
      context.setLineDash([5, 5]);
      context.beginPath();
      context.arc(pulse.position.x, pulse.position.y, radius, 0, Math.PI * 2);
      context.stroke();
      context.restore();
    }
  }

  private drawTarget(state: RenderState) {
    if (!state.targetFood) return;
    const context = this.context;
    const head = state.body.renderNodeAt(0, state.interpolation);
    const target = centerOf(state.targetFood.rect);
    const progress = Math.min(1, state.chewAmount);
    context.save();
    context.globalAlpha = 0.15 + progress * 0.25;
    context.strokeStyle = "#000000";
    context.lineWidth = 1.5;
    context.setLineDash([2, 7]);
    context.beginPath();
    context.moveTo(head.x, head.y);
    const midpointX = (head.x + target.x) / 2;
    context.bezierCurveTo(midpointX, head.y - 22, midpointX, target.y + 22, target.x, target.y);
    context.stroke();
    context.restore();
  }

  private drawDroppings(droppings: Dropping[]) {
    const context = this.context;
    for (const dropping of droppings) {
      const { x, y } = dropping.position;
      const entrance = clamp(dropping.age / 0.22);
      const emergence = 1 - Math.pow(1 - entrance, 3);
      const popScale =
        entrance < 1
          ? entrance + Math.sin(entrance * Math.PI) * 0.32
          : 1;
      context.save();
      context.translate(
        lerp(dropping.origin.x, x, emergence),
        lerp(dropping.origin.y, y, emergence)
      );
      context.rotate(dropping.rotation);
      context.scale(popScale, popScale);
      context.font = `${Math.round(dropping.size)}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("💩", 0, 0);
      context.restore();
    }
  }

  private drawDroppingTooltip(
    dropping: Dropping,
    snapshot: HabitatSnapshot
  ) {
    const context = this.context;
    const kind = dropping.matter?.kind.toUpperCase() ?? "UNKNOWN";
    const source =
      dropping.matter?.text.replace(/\s+/g, " ").trim() || "unknown matter";
    const snippet = source.length > 38 ? `${source.slice(0, 37)}…` : source;
    context.save();
    context.font = "15px ui-monospace, SFMono-Regular, Menlo, monospace";
    const width = clamp(context.measureText(snippet).width + 76, 220, 340);
    const height = 92;
    const visibleLeft = snapshot.scrollX + 8;
    const visibleRight = snapshot.scrollX + snapshot.viewportWidth - 8;
    const visibleTop = snapshot.scrollY + 8;
    const visibleBottom = snapshot.scrollY + snapshot.viewportHeight - 8;
    let left = dropping.position.x + 38;
    if (left + width > visibleRight) left = dropping.position.x - width - 38;
    left = clamp(left, visibleLeft, Math.max(visibleLeft, visibleRight - width));
    const top = clamp(
      dropping.position.y - height - 28,
      visibleTop,
      Math.max(visibleTop, visibleBottom - height)
    );
    context.restore();

    this.drawPixelCloud(
      { x: left + width / 2, y: top + height / 2 },
      width,
      height,
      1,
      (cloud, x, y, cloudWidth, cloudHeight) => {
        cloud.fillStyle = "#000000";
        cloud.textAlign = "center";
        cloud.textBaseline = "middle";
        cloud.font =
          "bold 14px ui-monospace, SFMono-Regular, Menlo, monospace";
        cloud.fillText(
          `POOP OF ${kind}`,
          x + cloudWidth * 0.5,
          y + cloudHeight * 0.42,
          cloudWidth * 0.72
        );
        cloud.font =
          "15px ui-monospace, SFMono-Regular, Menlo, monospace";
        cloud.fillText(
          snippet,
          x + cloudWidth * 0.5,
          y + cloudHeight * 0.64,
          cloudWidth * 0.7
        );
      }
    );
  }

  private drawFaceBubble(
    state: RenderState,
    message: "🎵" | "💨" | "💢"
  ) {
    const context = this.context;
    const { snapshot, body } = state;
    const head = body.renderNodeAt(0, state.interpolation);
    const direction = body.renderTravelDirection(state.interpolation);
    const width = 86;
    const height = 62;
    const visibleLeft = snapshot.scrollX + 8;
    const visibleRight = snapshot.scrollX + snapshot.viewportWidth - 8;
    const visibleTop = snapshot.scrollY + 8;
    const visibleBottom = snapshot.scrollY + snapshot.viewportHeight - 8;
    const left = clamp(
      head.x + direction.x * 36 - width / 2,
      visibleLeft,
      Math.max(visibleLeft, visibleRight - width)
    );
    const top = clamp(
      head.y - 116,
      visibleTop,
      Math.max(visibleTop, visibleBottom - height)
    );
    const centre = { x: left + width / 2, y: top + height / 2 };
    const pulse = 0.96 + Math.sin(state.now * 0.018) * 0.04;

    this.drawPixelCloud(
      centre,
      width,
      height,
      pulse,
      (cloud, x, y, cloudWidth, cloudHeight) => {
        cloud.font = `30px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
        cloud.textAlign = "center";
        cloud.textBaseline = "middle";
        cloud.fillText(
          message,
          x + cloudWidth * 0.5,
          y + cloudHeight * 0.55
        );
      }
    );
  }

  private drawPixelCloud(
    centre: Vec2,
    width: number,
    height: number,
    pulse: number,
    drawContents: (
      context: CanvasRenderingContext2D,
      x: number,
      y: number,
      width: number,
      height: number
    ) => void
  ) {
    const context = this.context;
    const padding = 8;
    const surfaceWidth = width + padding * 2;
    const surfaceHeight = height + padding * 2;
    const bitmapWidth = Math.ceil(surfaceWidth * MESSAGE_PIXEL_SCALE);
    const bitmapHeight = Math.ceil(surfaceHeight * MESSAGE_PIXEL_SCALE);
    if (this.messageSurface.width !== bitmapWidth) {
      this.messageSurface.width = bitmapWidth;
    }
    if (this.messageSurface.height !== bitmapHeight) {
      this.messageSurface.height = bitmapHeight;
    }

    const cloud = this.messageContext;
    cloud.setTransform(1, 0, 0, 1, 0, 0);
    cloud.clearRect(0, 0, bitmapWidth, bitmapHeight);
    cloud.imageSmoothingEnabled = false;
    cloud.setTransform(
      MESSAGE_PIXEL_SCALE,
      0,
      0,
      MESSAGE_PIXEL_SCALE,
      0,
      0
    );
    const x = padding;
    const y = padding;
    cloud.fillStyle = "#ffffff";
    cloud.strokeStyle = "#000000";
    cloud.lineWidth = 3;
    cloud.lineJoin = "round";
    traceMessageCloud(cloud, x, y, width, height);
    cloud.fill();
    cloud.stroke();
    drawContents(cloud, x, y, width, height);
    cloud.setTransform(1, 0, 0, 1, 0, 0);
    hardenMessagePixels(cloud, bitmapWidth, bitmapHeight);

    const drawWidth = bitmapWidth / MESSAGE_PIXEL_SCALE;
    const drawHeight = bitmapHeight / MESSAGE_PIXEL_SCALE;
    context.save();
    context.imageSmoothingEnabled = false;
    context.translate(centre.x, centre.y);
    context.scale(pulse, pulse);
    context.drawImage(
      this.messageSurface,
      -drawWidth / 2,
      -drawHeight / 2,
      drawWidth,
      drawHeight
    );
    context.restore();
  }

  private creatureBounds(
    body: CaterpillarBody,
    interpolation: number
  ): CreatureBounds {
    const bodyPoints = body.nodes.map((_, index) =>
      body.renderNodeAt(index, interpolation)
    );
    const points: Vec2[] = [...bodyPoints];
    for (let legIndex = 0; legIndex < body.legs.length; legIndex += 1) {
      points.push(...body.renderLegPointsAt(legIndex, interpolation));
    }
    const centre = bodyPoints.reduce(
      (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
      { x: 0, y: 0 }
    );
    centre.x /= Math.max(1, bodyPoints.length);
    centre.y /= Math.max(1, bodyPoints.length);
    const maximumOffset = points.reduce(
      (largest, point) =>
        Math.max(
          largest,
          Math.abs(point.x - centre.x),
          Math.abs(point.y - centre.y)
        ),
      0
    );
    // A normally fixed local raster keeps the jagged pixel pattern attached to
    // the animal. It grows only for a genuinely exceptional limb pose.
    const halfExtent = Math.max(224, Math.ceil(maximumOffset + 34));
    return {
      x: centre.x - halfExtent,
      y: centre.y - halfExtent,
      width: halfExtent * 2,
      height: halfExtent * 2,
    };
  }

  private drawPixelatedCreature(state: RenderState, body: CaterpillarBody) {
    const bounds = this.creatureBounds(body, state.interpolation);
    const bitmapWidth = Math.max(
      1,
      Math.ceil(bounds.width * CREATURE_PIXEL_SCALE)
    );
    const bitmapHeight = Math.max(
      1,
      Math.ceil(bounds.height * CREATURE_PIXEL_SCALE)
    );
    if (this.creatureSurface.width !== bitmapWidth) {
      this.creatureSurface.width = bitmapWidth;
    }
    if (this.creatureSurface.height !== bitmapHeight) {
      this.creatureSurface.height = bitmapHeight;
    }

    const creatureContext = this.creatureContext;
    creatureContext.setTransform(1, 0, 0, 1, 0, 0);
    creatureContext.clearRect(0, 0, bitmapWidth, bitmapHeight);
    creatureContext.imageSmoothingEnabled = false;
    creatureContext.setTransform(
      CREATURE_PIXEL_SCALE,
      0,
      0,
      CREATURE_PIXEL_SCALE,
      -bounds.x * CREATURE_PIXEL_SCALE,
      -bounds.y * CREATURE_PIXEL_SCALE
    );
    this.drawCreature(state, body, creatureContext, state.interpolation);
    creatureContext.setTransform(1, 0, 0, 1, 0, 0);
    hardenCreaturePixels(creatureContext, bitmapWidth, bitmapHeight);

    // The sprite's internal drawing is coarse, but its world-space origin is
    // composited at the interpolated floating-point position. The pixel style
    // therefore does not quantise locomotion back into four-pixel jumps.
    const context = this.context;
    const { snapshot } = state;
    context.save();
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    context.imageSmoothingEnabled = false;
    context.drawImage(
      this.creatureSurface,
      0,
      0,
      bitmapWidth,
      bitmapHeight,
      bounds.x + snapshot.canvasOffsetX - snapshot.scrollX,
      bounds.y + snapshot.canvasOffsetY - snapshot.scrollY,
      bitmapWidth / CREATURE_PIXEL_SCALE,
      bitmapHeight / CREATURE_PIXEL_SCALE
    );
    context.restore();
  }

  private drawCreature(
    state: RenderState,
    body: CaterpillarBody,
    context: CanvasRenderingContext2D,
    interpolation: number
  ) {
    const head = body.renderNodeAt(0, interpolation);

    if (state.hatching < 1) {
      const eggOpacity = 1 - clamp((state.hatching - 0.42) / 0.58);
      context.save();
      context.globalAlpha = eggOpacity;
      context.translate(head.x, head.y);
      context.rotate(-0.08);
      context.fillStyle = "#ffffff";
      context.strokeStyle = "#000000";
      context.lineWidth = 4;
      context.beginPath();
      context.ellipse(0, 0, 21, 27, 0, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.beginPath();
      context.moveTo(-8, -9);
      context.lineTo(-1, -2);
      context.lineTo(-7, 4);
      context.lineTo(4, 10);
      context.stroke();
      context.restore();
    }

    this.drawLegs(body, context, interpolation, -1);
    this.drawNearLegAttachments(body, context, interpolation);
    this.drawBody(body, context, interpolation);
    this.drawLegs(body, context, interpolation, 1, false);
    this.drawHead(body, context, interpolation, state.chewAmount);
  }

  private drawLocomotionPlan(state: RenderState) {
    const context = this.context;
    const { body } = state;
    const direction = body.renderTravelDirection(state.interpolation);
    const normal = { x: -direction.y, y: direction.x };
    const start = body.renderNodeAt(0, state.interpolation);
    const bend = clamp(body.turnRate / MAX_TURN_RATE, -1, 1) * 68;
    const control = {
      x: start.x + direction.x * 44,
      y: start.y + direction.y * 44,
    };
    const end = {
      x: start.x + direction.x * 78 + normal.x * bend,
      y: start.y + direction.y * 78 + normal.y * bend,
    };
    const endDirection = normalize(
      { x: end.x - control.x, y: end.y - control.y },
      direction
    );
    const endNormal = { x: -endDirection.y, y: endDirection.x };

    context.save();
    context.globalAlpha = 0.52;
    context.strokeStyle = "#000000";
    context.lineWidth = 2;
    context.setLineDash([6, 5]);
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.quadraticCurveTo(control.x, control.y, end.x, end.y);
    context.stroke();
    context.setLineDash([]);
    context.beginPath();
    context.moveTo(end.x, end.y);
    context.lineTo(
      end.x - endDirection.x * 12 + endNormal.x * 6,
      end.y - endDirection.y * 12 + endNormal.y * 6
    );
    context.moveTo(end.x, end.y);
    context.lineTo(
      end.x - endDirection.x * 12 - endNormal.x * 6,
      end.y - endDirection.y * 12 - endNormal.y * 6
    );
    context.stroke();

    if (DEBUG_SHOW_LANDING_TARGETS) {
      for (const leg of body.legs) {
        if (leg.mode === "stance") continue;
        const target = leg.landingTarget;
        context.beginPath();
        context.arc(target.x, target.y, 7, 0, Math.PI * 2);
        context.stroke();
        context.beginPath();
        context.moveTo(target.x - 4, target.y);
        context.lineTo(target.x + 4, target.y);
        context.moveTo(target.x, target.y - 4);
        context.lineTo(target.x, target.y + 4);
        context.stroke();
      }
    }
    context.restore();
  }

  private drawLegs(
    body: CaterpillarBody,
    context: CanvasRenderingContext2D,
    interpolation: number,
    sideLayer: -1 | 1,
    includeAttachment = true
  ) {
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";

    for (const [legIndex, leg] of body.legs.entries()) {
      if (leg.side !== sideLayer) continue;
      const points = body.renderLegPointsAt(legIndex, interpolation);
      const growth = clamp(body.growth, 0.05, 1);
      const linkWidths = [4.6, 4.1, 3.6];
      const firstVisibleIndex = includeAttachment ? 0 : 1;
      for (let index = firstVisibleIndex; index < 3; index += 1) {
        context.strokeStyle = "#000000";
        context.lineWidth = linkWidths[index] * growth;
        context.beginPath();
        context.moveTo(points[index].x, points[index].y);
        context.lineTo(points[index + 1].x, points[index + 1].y);
        context.stroke();
      }

      // Large white joint discs make the actual three-link mechanism readable.
      for (let index = firstVisibleIndex; index < 3; index += 1) {
        const radius = (index === 0 ? 6.2 : index === 1 ? 6.8 : 6.3) * growth;
        context.fillStyle = "#ffffff";
        context.strokeStyle = "#000000";
        context.lineWidth = 2.2 * growth;
        traceWobblyCircle(
          context,
          points[index],
          radius,
          300 + legIndex * 19 + index * 5,
          0.04
        );
        context.fill();
        context.stroke();
      }

      const handRadius = (10.5 + leg.load * 2.2) * growth;
      context.fillStyle = "#ffffff";
      context.strokeStyle = "#000000";
      context.lineWidth = 2.7 * growth;
      traceWobblyCircle(
        context,
        points[3],
        handRadius,
        700 + legIndex * 29,
        0.045
      );
      context.fill();
      context.stroke();
    }
    context.restore();
  }

  private drawNearLegAttachments(
    body: CaterpillarBody,
    context: CanvasRenderingContext2D,
    interpolation: number
  ) {
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";

    for (const [legIndex, leg] of body.legs.entries()) {
      if (leg.side !== 1) continue;
      const points = body.renderLegPointsAt(legIndex, interpolation);
      const growth = clamp(body.growth, 0.05, 1);
      context.strokeStyle = "#000000";
      context.lineWidth = 4.6 * growth;
      context.beginPath();
      context.moveTo(points[0].x, points[0].y);
      context.lineTo(points[1].x, points[1].y);
      context.stroke();

      const rootRadius = 6.2 * growth;
      context.fillStyle = "#ffffff";
      context.strokeStyle = "#000000";
      context.lineWidth = 2.2 * growth;
      traceWobblyCircle(
        context,
        points[0],
        rootRadius,
        300 + legIndex * 19,
        0.04
      );
      context.fill();
      context.stroke();
    }
    context.restore();
  }

  private drawBody(
    body: CaterpillarBody,
    context: CanvasRenderingContext2D,
    interpolation: number
  ) {
    const nodes = body.nodes.map((_, index) =>
      body.renderNodeAt(index, interpolation)
    );
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";

    context.strokeStyle = "#000000";
    context.lineWidth = 5 * clamp(body.growth, 0.04, 1);
    context.beginPath();
    context.moveTo(nodes[nodes.length - 1].x, nodes[nodes.length - 1].y);
    for (let index = nodes.length - 2; index >= 0; index -= 1) {
      const point = nodes[index];
      context.lineTo(point.x, point.y);
    }
    context.stroke();

    for (let index = nodes.length - 1; index >= 1; index -= 1) {
      const node = nodes[index];
      const radius = body.renderRadiusAt(index, interpolation);
      context.fillStyle = "#ffffff";
      context.strokeStyle = "#000000";
      context.lineWidth = 2.8;
      traceWobblyCircle(
        context,
        node,
        radius,
        1500 + index * 31,
        0.045
      );
      context.fill();
      context.stroke();
    }
    context.restore();
  }

  private drawHead(
    body: CaterpillarBody,
    context: CanvasRenderingContext2D,
    interpolation: number,
    chewAmount: number
  ) {
    const head = body.renderNodeAt(0, interpolation);
    const direction = body.renderTravelDirection(interpolation);
    const normal = { x: -direction.y, y: direction.x };
    const angle = Math.atan2(direction.y, direction.x);
    const radius = body.renderRadiusAt(0, interpolation) * 1.12;
    const bodywardOffset = 2;
    const chewProgress = clamp(chewAmount);
    const chewEnvelope = Math.sin(Math.PI * chewProgress);
    const chewPhase = chewProgress * Math.PI * 2 * 5;
    const forwardBob =
      (Math.sin(chewPhase) * 10.5 +
        Math.sin(chewPhase * 2.15 + 0.4) * 2.8) *
      chewEnvelope;
    const sidewaysBob =
      (Math.sin(chewPhase * 0.72 + 0.9) * 8 +
        Math.sin(chewPhase * 1.7) * 2.1) *
      chewEnvelope;
    const chewRotation =
      Math.sin(chewPhase + 0.45) * 0.28 * chewEnvelope;
    const chewSize =
      1 + Math.sin(chewPhase - 0.35) * 0.38 * chewEnvelope;
    const chewSquash =
      Math.sin(chewPhase * 2 + 0.25) * 0.14 * chewEnvelope;

    context.save();
    context.translate(
      head.x - direction.x * bodywardOffset +
        direction.x * forwardBob +
        normal.x * sidewaysBob,
      head.y - direction.y * bodywardOffset +
        direction.y * forwardBob +
        normal.y * sidewaysBob
    );
    context.rotate(angle + (Math.PI * 3) / 2 + chewRotation);
    context.scale(
      chewSize * (1 + chewSquash),
      chewSize * (1 - chewSquash)
    );
    if (this.faceImage.complete && this.faceImage.naturalWidth > 0) {
      const faceSize = radius * 3.4 * 1.5 * 1.3 * 1.2 * 0.8 * 0.7;
      context.imageSmoothingEnabled = false;
      context.drawImage(
        this.faceImage,
        -faceSize * 0.5,
        -faceSize * 0.5,
        faceSize,
        faceSize
      );
    }
    context.restore();
  }
}

export function droppingAtPoint(
  droppings: Dropping[],
  point: Vec2,
  radius = 24
) {
  return droppings.find((dropping) => distance(dropping.position, point) <= radius) ?? null;
}
