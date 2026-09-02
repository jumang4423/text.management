import { CaterpillarBody } from "./body";
import { CaterpillarBrain } from "./brain";
import {
  add,
  centerOf,
  clamp,
  closestPointOnRect,
  distance,
  normalize,
  Random,
  scale,
  subtract,
  type Rect,
  type Vec2,
} from "./math";
import {
  BugRenderer,
  droppingAtPoint,
  type Dropping,
  type SoundPulseVisual,
} from "./renderer";
import type {
  BrainDecision,
  BodyControl,
  CreatureMode,
  CreatureVitals,
  EdibleCode,
  EatenMatter,
  HabitatAdapter,
  HabitatSnapshot,
  PointerSense,
} from "./types";

interface StomachItem {
  matter: EatenMatter;
  remaining: number;
}

interface ChewState {
  foodId: string;
  elapsed: number;
}

interface PoopMission {
  matter: EatenMatter;
  target: Vec2;
  arrivedFor: number;
  settled: boolean;
}

const LOCOMOTION_TIME_SCALE = 5;
const TEST_BUG_COUNT = 1;
const POINTER_CRUISE_SPEED = 130;
const POINTER_ARRIVAL_RADIUS = 72;
const POINTER_RESUME_RADIUS = 96;
const POINTER_ANGER_RADIUS = 180;
const ANGER_BUBBLE_HOLD_MS = 2_000;
const TOILET_ARRIVAL_RADIUS = 52;
const POOP_MIN_SPACING = 96;
const POOP_ANIMATION_SECONDS = 1.15;

export interface BugWorldMetrics extends CreatureVitals {
  foodCount: number;
  target: string | null;
}

export class BugWorld {
  readonly renderer: BugRenderer;
  readonly body: CaterpillarBody;
  readonly bodies: CaterpillarBody[];
  readonly brain = new CaterpillarBrain();

  mode: CreatureMode = "nibble";
  autoPulse = false;
  showScent = true;
  onMetrics: ((metrics: BugWorldMetrics) => void) | null = null;

  private readonly random = new Random(0xb0611fe);
  private readonly droppings: Dropping[] = [];
  private readonly pulses: SoundPulseVisual[] = [];
  private readonly stomach: StomachItem[] = [];
  private readonly swarmArrived = Array.from(
    { length: TEST_BUG_COUNT },
    () => false
  );
  private snapshot: HabitatSnapshot;
  private pointer: PointerSense = {
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    speed: 0,
    active: false,
  };
  private chew: ChewState | null = null;
  private animationFrame = 0;
  private lastFrameAt = performance.now();
  private accumulator = 0;
  private simulationAge = 0;
  private snapshotAge = 0;
  private lastAutoPulseAt = 0;
  private lastPointerAt = performance.now();
  private lastMetricsAt = 0;
  private forageFoodId: string | null = null;
  private forageBestDistance = Infinity;
  private forageStalledFor = 0;
  private hoveredDroppingId: string | null = null;
  private poopMission: PoopMission | null = null;
  private angerBubbleUntil = 0;

  constructor(
    private readonly habitat: HabitatAdapter,
    private readonly canvas: HTMLCanvasElement
  ) {
    this.snapshot = habitat.snapshot(performance.now());
    this.bodies = Array.from({ length: TEST_BUG_COUNT }, (_, index) =>
      new CaterpillarBody(this.spawnPosition(this.snapshot, index), {
        randomSeed: 0xb067a11 ^ Math.imul(index + 1, 0x9e3779b1),
      })
    );
    this.body = this.bodies[0];
    this.renderer = new BugRenderer(canvas);
  }

  start() {
    if (this.animationFrame) return;
    this.lastFrameAt = performance.now();
    this.animationFrame = requestAnimationFrame(this.frame);
  }

  destroy() {
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.stopChewing();
  }

  reset() {
    this.brain.reset();
    this.snapshot = this.habitat.snapshot(performance.now());
    for (const [index, body] of this.bodies.entries()) {
      body.reset(this.spawnPosition(this.snapshot, index));
    }
    this.swarmArrived.fill(false);
    this.droppings.length = 0;
    this.hoveredDroppingId = null;
    this.angerBubbleUntil = 0;
    this.pulses.length = 0;
    this.stomach.length = 0;
    this.poopMission = null;
    this.stopChewing();
    this.resetForageProgress();
    this.simulationAge = 0;
  }

  starve() {
    this.brain.starve();
  }

  soundPulse() {
    const now = performance.now();
    const pulse = this.habitat.pulseRandom(now);
    if (!pulse) return;
    this.pulses.push({ ...pulse, age: 0 });
    for (const body of this.bodies) {
      body.impulse(pulse.position, pulse.strength * 10);
    }
  }

  pointerMove(stagePosition: Vec2, timestamp = performance.now()) {
    const worldPosition = this.habitat.stageToWorld(stagePosition);
    const deltaSeconds = Math.max(0.001, (timestamp - this.lastPointerAt) / 1_000);
    const velocity = scale(subtract(worldPosition, this.pointer.position), 1 / deltaSeconds);
    this.pointer = {
      position: worldPosition,
      velocity,
      speed: Math.min(1_200, Math.hypot(velocity.x, velocity.y)),
      active: true,
    };
    if (distance(worldPosition, this.body.head) < POINTER_ANGER_RADIUS) {
      this.angerBubbleUntil = Math.max(
        this.angerBubbleUntil,
        timestamp + ANGER_BUBBLE_HOLD_MS
      );
    }
    this.updateDroppingHover();
    this.lastPointerAt = timestamp;
  }

  pointerLeave() {
    this.pointer = {
      ...this.pointer,
      speed: 0,
      active: false,
    };
    this.hoveredDroppingId = null;
  }

  pointerDown(stagePosition: Vec2) {
    const worldPosition = this.habitat.stageToWorld(stagePosition);
    const dropping = droppingAtPoint(this.droppings, worldPosition);
    if (dropping?.matter) {
      this.habitat.restore(dropping.matter);
      this.droppings.splice(this.droppings.indexOf(dropping), 1);
      this.hoveredDroppingId = null;
      return true;
    }

    const touchedBody = this.bodies.find(
      (body) => distance(worldPosition, body.head) < 34
    );
    if (touchedBody) {
      this.angerBubbleUntil = Math.max(
        this.angerBubbleUntil,
        performance.now() + ANGER_BUBBLE_HOLD_MS
      );
      touchedBody.impulse(worldPosition, 16);
      return true;
    }
    return false;
  }

  metrics(): BugWorldMetrics {
    const vitals = this.brain.vitals();
    const target = this.targetFood();
    return {
      ...vitals,
      foodCount: this.snapshot.edibles.length,
      target: target?.text.trim() ?? null,
    };
  }

  private readonly frame = (now: number) => {
    const elapsed = Math.min(0.08, Math.max(0, (now - this.lastFrameAt) / 1_000));
    this.lastFrameAt = now;
    this.accumulator += elapsed;
    const fixedStep = 1 / 60;
    let steps = 0;
    while (this.accumulator >= fixedStep && steps < 4) {
      this.step(fixedStep, now);
      this.accumulator -= fixedStep;
      steps += 1;
    }
    if (steps === 4) this.accumulator = 0;
    const interpolation = clamp(this.accumulator / fixedStep);

    this.renderer.render({
      body: this.body,
      bodies: this.bodies,
      behaviour: this.brain.behaviour,
      snapshot: this.snapshot,
      targetFood: this.showScent ? this.targetFood() : null,
      chewAmount: this.chew ? clamp(this.chew.elapsed / 1.28) : 0,
      faceBubble:
        now < this.angerBubbleUntil
          ? "💢"
          : this.chew
            ? "🎵"
            : this.poopMission?.settled
              ? "💨"
              : null,
      droppings: this.droppings,
      hoveredDropping:
        this.droppings.find(
          (dropping) => dropping.id === this.hoveredDroppingId
        ) ?? null,
      pulses: this.pulses,
      hatching: clamp(this.simulationAge / 0.65),
      now,
      interpolation,
    });

    if (now - this.lastMetricsAt > 90) {
      this.lastMetricsAt = now;
      this.onMetrics?.(this.metrics());
    }
    this.animationFrame = requestAnimationFrame(this.frame);
  };

  private step(deltaSeconds: number, now: number) {
    // Preserve the last complete physics pose. Rendering interpolates from this
    // snapshot to the new pose, so 60 Hz simulation remains fluid on 120 Hz
    // displays instead of visibly holding every other animation frame.
    for (const body of this.bodies) body.captureRenderPose();
    this.simulationAge += deltaSeconds;
    this.snapshotAge += deltaSeconds;
    if (this.snapshotAge > 0.22) {
      this.snapshot = this.habitat.snapshot(now);
      this.snapshotAge = 0;
    }

    if (this.autoPulse && now - this.lastAutoPulseAt > 820) {
      this.lastAutoPulseAt = now;
      this.soundPulse();
    }

    const worldBounds: Rect = {
      x: 0,
      y: 0,
      width: Math.max(180, this.snapshot.worldWidth),
      height: Math.max(180, this.snapshot.worldHeight),
    };
    const visibleBounds: Rect = {
      x: this.snapshot.scrollX,
      y: this.snapshot.scrollY,
      width: Math.max(180, this.snapshot.viewportWidth),
      height: Math.max(180, this.snapshot.viewportHeight),
    };
    const decision = this.brain.update({
      now,
      deltaSeconds,
      head: this.body.head,
      bounds: visibleBounds,
      pointer: this.pointer,
      foods: this.snapshot.edibles,
      chewing: this.chew !== null,
      toiletTarget: this.poopMission?.target ?? null,
    });

    if (decision.behaviour === "fleeing") {
      this.angerBubbleUntil = Math.max(
        this.angerBubbleUntil,
        now + ANGER_BUBBLE_HOLD_MS
      );
      this.stopChewing();
      this.resetForageProgress();
      if (this.poopMission?.settled) {
        this.poopMission.target = this.chooseToiletTarget();
        this.poopMission.arrivedFor = 0;
        this.poopMission.settled = false;
      }
    }
    else this.updateChewing(deltaSeconds, decision);
    const control = { ...decision.control };
    if (this.chew && decision.behaviour !== "fleeing") {
      const target = this.targetFood();
      if (target) {
        control.direction = normalize(subtract(centerOf(target.rect), this.body.head));
      }
      control.speed = 0;
      control.gaitHz = 2.8;
      control.wriggle = 0.9;
      control.chew = 1;
    }
    if (this.poopMission?.settled && decision.behaviour === "toileting") {
      control.speed = 0;
      control.gaitHz = 0.7;
      control.wriggle = 1.1;
      control.sleep = 0;
      control.poop = 1;
    }
    control.gut = clamp(
      this.stomach.reduce(
        (sum, item) => sum + item.matter.nutrition * 0.16,
        0
      )
    );
    const growth = Math.min(1, this.simulationAge / 0.65);
    // Ten bodies share the document but own independent joints, contacts and
    // seeded gait variation. Only the primary body owns eating/metabolism.
    for (const [index, body] of this.bodies.entries()) {
      body.growth = growth;
      const bodyControl =
        index === 0
          ? control
          : this.swarmControl(index, control, worldBounds);
      for (
        let locomotionStep = 0;
        locomotionStep < LOCOMOTION_TIME_SCALE;
        locomotionStep += 1
      ) {
        body.update(deltaSeconds, bodyControl, worldBounds);
      }
    }

    this.updateDigestion(deltaSeconds, decision.behaviour);
    this.updateDroppings(deltaSeconds);
    this.updateDroppingHover();
    this.updatePulses(deltaSeconds);
    this.pointer.speed *= Math.pow(0.7, deltaSeconds * 60);
  }

  private updateChewing(deltaSeconds: number, decision: BrainDecision) {
    const target = this.targetFood(decision.targetFoodId);
    if (!this.chew && decision.behaviour === "foraging" && target) {
      const bitePoint = closestPointOnRect(this.body.head, target.rect);
      const mouthDistance = distance(this.body.head, bitePoint);

      if (this.forageFoodId !== target.id) {
        this.forageFoodId = target.id;
        this.forageBestDistance = mouthDistance;
        this.forageStalledFor = 0;
      } else if (mouthDistance < this.forageBestDistance - 1.5) {
        this.forageBestDistance = mouthDistance;
        this.forageStalledFor = 0;
      } else {
        this.forageStalledFor += deltaSeconds;
      }

      // The ordinary trigger is geometric distance to the code rectangle. The
      // second trigger is a narrow deadlock guard: if the mouth has spent over
      // a second circling within one body length, finish the already-visible
      // approach instead of allowing an endless one-sided turn.
      const reachedFood = mouthDistance < 42;
      const stalledBesideFood =
        mouthDistance < 68 && this.forageStalledFor > 1.25;
      if (reachedFood || stalledBesideFood) {
        this.chew = { foodId: target.id, elapsed: 0 };
        this.habitat.setChewing(target);
        this.resetForageProgress();
      }
    } else if (!this.chew) {
      this.resetForageProgress();
    }

    if (!this.chew) return;
    const chewingFood = this.targetFood(this.chew.foodId);
    if (!chewingFood) {
      this.stopChewing();
      this.resetForageProgress();
      return;
    }

    this.chew.elapsed += deltaSeconds;

    if (this.chew.elapsed < 1.28) return;
    let matter: EatenMatter | null = null;
    if (this.mode === "nibble") matter = this.habitat.eat(chewingFood);
    if (matter) {
      this.stomach.push({
        matter,
        remaining: 4.2 + this.random.between(0, 2.4),
      });
      this.brain.onEat(matter.nutrition);
      this.snapshotAge = 1;
    } else {
      this.brain.onEat(chewingFood.nutrition * 0.42);
    }
    this.stopChewing();
  }

  private stopChewing() {
    this.chew = null;
    this.habitat.setChewing(null);
  }

  private resetForageProgress() {
    this.forageFoodId = null;
    this.forageBestDistance = Infinity;
    this.forageStalledFor = 0;
  }

  private updateDigestion(
    deltaSeconds: number,
    behaviour: BrainDecision["behaviour"]
  ) {
    for (let index = 0; index < this.stomach.length; index += 1) {
      const item = this.stomach[index];
      item.remaining -= deltaSeconds;
    }

    if (!this.poopMission && !this.chew) {
      const readyIndex = this.stomach.findIndex((item) => item.remaining <= 0);
      if (readyIndex >= 0) {
        const [ready] = this.stomach.splice(readyIndex, 1);
        this.poopMission = {
          matter: ready.matter,
          target: this.chooseToiletTarget(),
          arrivedFor: 0,
          settled: false,
        };
      }
    }

    const mission = this.poopMission;
    if (!mission || behaviour !== "toileting") return;
    if (!mission.settled) {
      const targetDistance = distance(this.body.head, mission.target);
      if (targetDistance > TOILET_ARRIVAL_RADIUS) return;
      mission.settled = true;
      mission.arrivedFor = 0;
    }

    mission.arrivedFor += deltaSeconds;
    if (mission.arrivedFor < POOP_ANIMATION_SECONDS) return;
    const placement = this.tailPoopPlacement();
    if (!this.poopSpotIsClear(placement.position)) {
      mission.target = this.chooseToiletTarget();
      mission.arrivedFor = 0;
      mission.settled = false;
      return;
    }

    this.droppings.push({
      id: mission.matter.id,
      ...placement,
      matter: mission.matter,
      age: 0,
      size: this.random.between(30, 38),
      rotation: this.random.between(-0.18, 0.18),
    });
    this.poopMission = null;
    this.brain.onPoop();
  }

  private chooseToiletTarget(): Vec2 {
    const horizontalMargin = Math.min(
      130,
      Math.max(54, this.snapshot.viewportWidth * 0.18)
    );
    const verticalMargin = Math.min(
      110,
      Math.max(54, this.snapshot.viewportHeight * 0.18)
    );
    const availableWidth = Math.max(
      1,
      this.snapshot.viewportWidth - horizontalMargin * 2
    );
    const availableHeight = Math.max(
      1,
      this.snapshot.viewportHeight - verticalMargin * 2
    );
    let best = { ...this.body.head };
    let bestScore = -Infinity;

    for (let index = 0; index < 36; index += 1) {
      const candidate = {
        x:
          this.snapshot.scrollX +
          horizontalMargin +
          this.random.next() * availableWidth,
        y:
          this.snapshot.scrollY +
          verticalMargin +
          this.random.next() * availableHeight,
      };
      const route = normalize(
        subtract(candidate, this.body.head),
        this.body.travelDirection
      );
      const predictedTailDistance =
        this.body.segmentLength * (this.body.nodes.length - 1) * 0.76 + 32;
      const predictedPoop = subtract(
        candidate,
        scale(route, predictedTailDistance)
      );
      const nearestPoop = this.droppings.reduce(
        (nearest, dropping) =>
          Math.min(nearest, distance(predictedPoop, dropping.position)),
        Math.hypot(this.snapshot.viewportWidth, this.snapshot.viewportHeight)
      );
      const travelDistance = distance(candidate, this.body.head);
      const score = nearestPoop + Math.min(280, travelDistance) * 0.18;
      if (score <= bestScore) continue;
      best = candidate;
      bestScore = score;
    }
    return best;
  }

  private tailPoopPlacement() {
    const tailIndex = this.body.nodes.length - 1;
    const tail = this.body.renderNodeAt(tailIndex, 1);
    const previous = this.body.renderNodeAt(Math.max(0, tailIndex - 1), 1);
    const outward = normalize(subtract(tail, previous), { x: -1, y: 0 });
    const tailRadius = this.body.radiusAt(tailIndex);
    return {
      origin: add(tail, scale(outward, tailRadius * 0.55)),
      position: add(tail, scale(outward, tailRadius + 20)),
    };
  }

  private poopSpotIsClear(position: Vec2) {
    return this.droppings.every(
      (dropping) => distance(position, dropping.position) >= POOP_MIN_SPACING
    );
  }

  private updateDroppings(deltaSeconds: number) {
    for (const dropping of this.droppings) {
      dropping.age += deltaSeconds;
    }
  }

  private updateDroppingHover() {
    if (!this.pointer.active) {
      this.hoveredDroppingId = null;
      return;
    }
    this.hoveredDroppingId =
      droppingAtPoint(this.droppings, this.pointer.position)?.id ?? null;
  }

  private updatePulses(deltaSeconds: number) {
    for (let index = this.pulses.length - 1; index >= 0; index -= 1) {
      this.pulses[index].age += deltaSeconds;
      if (this.pulses[index].age > 0.82) this.pulses.splice(index, 1);
    }
  }

  private targetFood(foodId = this.brain.targetFoodId) {
    if (!foodId) return null;
    return this.snapshot.edibles.find((food) => food.id === foodId) ?? null;
  }

  private startPosition(snapshot: HabitatSnapshot) {
    const visibleFoods = snapshot.edibles.filter((food) => {
      const y = food.rect.y - snapshot.scrollY;
      return y > 60 && y < snapshot.viewportHeight - 60;
    });
    const food = visibleFoods[Math.floor(visibleFoods.length * 0.45)];
    if (food) {
      return {
        x: clamp(centerOf(food.rect).x + 210, 180, snapshot.worldWidth - 45),
        y: clamp(centerOf(food.rect).y + 70, 70, snapshot.worldHeight - 70),
      };
    }
    return {
      x: Math.min(snapshot.worldWidth - 60, snapshot.scrollX + snapshot.viewportWidth * 0.65),
      y: Math.min(snapshot.worldHeight - 60, snapshot.scrollY + snapshot.viewportHeight * 0.45),
    };
  }

  private swarmControl(
    index: number,
    baseControl: BodyControl,
    bounds: Rect
  ): BodyControl {
    const body = this.bodies[index];
    const control: BodyControl = {
      ...baseControl,
      direction: { ...baseControl.direction },
    };

    if (this.pointer.active) {
      const offset = this.swarmOffset(index);
      const target = {
        x: clamp(
          this.pointer.position.x + offset.x,
          bounds.x + 42,
          bounds.x + bounds.width - 42
        ),
        y: clamp(
          this.pointer.position.y + offset.y,
          bounds.y + 42,
          bounds.y + bounds.height - 42
        ),
      };
      const targetDistance = distance(body.head, target);
      if (this.swarmArrived[index]) {
        if (targetDistance > POINTER_RESUME_RADIUS) {
          this.swarmArrived[index] = false;
        }
      } else if (targetDistance < POINTER_ARRIVAL_RADIUS) {
        this.swarmArrived[index] = true;
      }
      control.direction = normalize(
        subtract(target, body.head),
        body.travelDirection
      );
      control.speed = this.swarmArrived[index]
        ? 0
        : Math.max(POINTER_CRUISE_SPEED, baseControl.speed);
      return control;
    }

    this.swarmArrived[index] = false;
    const headingOffset = ((index % 3) - 1) * 0.065;
    const cosine = Math.cos(headingOffset);
    const sine = Math.sin(headingOffset);
    control.direction = {
      x: baseControl.direction.x * cosine - baseControl.direction.y * sine,
      y: baseControl.direction.x * sine + baseControl.direction.y * cosine,
    };
    return control;
  }

  private spawnPosition(snapshot: HabitatSnapshot, index: number): Vec2 {
    const origin = this.startPosition(snapshot);
    const offset = scale(this.swarmOffset(index), 0.82);
    return {
      x: clamp(origin.x + offset.x, 80, Math.max(80, snapshot.worldWidth - 45)),
      y: clamp(origin.y + offset.y, 55, Math.max(55, snapshot.worldHeight - 55)),
    };
  }

  private swarmOffset(index: number): Vec2 {
    if (index === 0) return { x: 0, y: 0 };
    const ringIndex = index - 1;
    const angle =
      (ringIndex / Math.max(1, TEST_BUG_COUNT - 1)) * Math.PI * 2;
    const radius = ringIndex % 2 === 0 ? 185 : 235;
    return {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    };
  }
}
