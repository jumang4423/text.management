import { CaterpillarBody } from "./body";
import { CaterpillarBrain } from "./brain";
import {
  add,
  centerOf,
  clamp,
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
  type CodeParticle,
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
  SoundStimulus,
} from "./types";

interface StomachItem {
  matter: EatenMatter;
  remaining: number;
}

interface ChewState {
  foodId: string;
  elapsed: number;
  lastCrumbAt: number;
}

const LOCOMOTION_TIME_SCALE = 5;
const TEST_BUG_COUNT = 1;
const POINTER_CRUISE_SPEED = 130;
const POINTER_ARRIVAL_RADIUS = 72;
const POINTER_RESUME_RADIUS = 96;

export interface BugWorldMetrics extends CreatureVitals {
  mode: CreatureMode;
  foodCount: number;
  poopCount: number;
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
  private readonly particles: CodeParticle[] = [];
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
  private latestStimulus: SoundStimulus | null = null;
  private stimulusPending = false;
  private chew: ChewState | null = null;
  private animationFrame = 0;
  private lastFrameAt = performance.now();
  private accumulator = 0;
  private simulationAge = 0;
  private snapshotAge = 0;
  private lastAutoPulseAt = 0;
  private lastPointerAt = performance.now();
  private lastMetricsAt = 0;

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
  }

  reset() {
    this.brain.reset();
    this.snapshot = this.habitat.snapshot(performance.now());
    for (const [index, body] of this.bodies.entries()) {
      body.reset(this.spawnPosition(this.snapshot, index));
    }
    this.swarmArrived.fill(false);
    this.particles.length = 0;
    this.droppings.length = 0;
    this.pulses.length = 0;
    this.stomach.length = 0;
    this.chew = null;
    this.simulationAge = 0;
    this.latestStimulus = null;
    this.stimulusPending = false;
  }

  starve() {
    this.brain.starve();
  }

  soundPulse() {
    const now = performance.now();
    const pulse = this.habitat.pulseRandom(now);
    if (!pulse) return;
    this.latestStimulus = {
      position: pulse.position,
      strength: pulse.strength,
      surprise: 0.75 + this.random.next() * 0.25,
      age: 0,
    };
    this.stimulusPending = true;
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
    this.lastPointerAt = timestamp;
  }

  pointerLeave() {
    // Pointer-follow test mode deliberately keeps chasing the last known point.
    this.pointer.speed = 0;
  }

  pointerDown(stagePosition: Vec2) {
    const worldPosition = this.habitat.stageToWorld(stagePosition);
    const dropping = droppingAtPoint(this.droppings, worldPosition);
    if (dropping?.matter) {
      this.habitat.restore(dropping.matter);
      this.spawnBurst(dropping.position, dropping.matter.text, "#6ed4e3", 14);
      this.droppings.splice(this.droppings.indexOf(dropping), 1);
      return true;
    }

    const touchedBody = this.bodies.find(
      (body) => distance(worldPosition, body.head) < 34
    );
    if (touchedBody) {
      this.brain.startle(worldPosition, 0.82, performance.now());
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
      mode: this.mode,
      foodCount: this.snapshot.edibles.length,
      poopCount: this.droppings.length,
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
      particles: this.particles,
      droppings: this.droppings,
      pulses: this.pulses,
      hatching: this.pointer.active ? 1 : clamp(this.simulationAge / 0.65),
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
    const stimulus = this.stimulusPending ? this.latestStimulus : null;
    if (this.pointer.active) this.chew = null;
    const decision = this.brain.update({
      now,
      deltaSeconds,
      head: this.body.head,
      bounds: worldBounds,
      pointer: this.pointer,
      foods: this.snapshot.edibles,
      stimulus,
      chewing: this.chew !== null,
    });
    this.stimulusPending = false;

    if (!this.pointer.active) this.updateChewing(deltaSeconds, decision);
    const control = { ...decision.control };
    if (this.chew && !this.pointer.active) {
      const target = this.targetFood();
      if (target) {
        control.direction = normalize(subtract(centerOf(target.rect), this.body.head));
      }
      control.speed = 3;
      control.gaitHz = 2.8;
      control.wriggle = 0.85;
    }
    control.gut = clamp(
      this.brain.gut +
        this.stomach.reduce((sum, item) => sum + item.matter.nutrition * 0.16, 0)
    );
    const growth = this.pointer.active
      ? 1
      : Math.min(1, this.simulationAge / 0.65);
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

    this.updateDigestion(deltaSeconds);
    this.updateParticles(deltaSeconds);
    this.updateDroppings(deltaSeconds, worldBounds);
    this.updatePulses(deltaSeconds);
    if (this.latestStimulus) this.latestStimulus.age += deltaSeconds;
    this.pointer.speed *= Math.pow(0.7, deltaSeconds * 60);
  }

  private updateChewing(deltaSeconds: number, decision: BrainDecision) {
    const target = this.targetFood(decision.targetFoodId);
    if (!this.chew && decision.behaviour === "foraging" && target) {
      const mouthDistance = distance(this.body.head, centerOf(target.rect));
      if (mouthDistance < Math.max(25, target.rect.width * 0.15)) {
        this.chew = { foodId: target.id, elapsed: 0, lastCrumbAt: -1 };
      }
    }

    if (!this.chew) return;
    const chewingFood = this.targetFood(this.chew.foodId);
    if (!chewingFood) {
      this.chew = null;
      return;
    }

    this.chew.elapsed += deltaSeconds;
    const biteIndex = Math.floor(this.chew.elapsed / 0.23);
    if (biteIndex > this.chew.lastCrumbAt) {
      this.chew.lastCrumbAt = biteIndex;
      this.spawnCrumb(chewingFood);
    }

    if (this.chew.elapsed < 1.28) return;
    let matter: EatenMatter | null = null;
    if (this.mode === "nibble") matter = this.habitat.eat(chewingFood);
    if (matter) {
      this.stomach.push({
        matter,
        remaining: 4.2 + this.random.between(0, 2.4),
      });
      this.brain.onEat(matter.nutrition);
      this.spawnBurst(this.body.head, matter.text, "#008000", 11);
      this.snapshotAge = 1;
    } else {
      this.brain.onEat(chewingFood.nutrition * 0.42);
    }
    this.chew = null;
  }

  private updateDigestion(deltaSeconds: number) {
    for (let index = this.stomach.length - 1; index >= 0; index -= 1) {
      const item = this.stomach[index];
      item.remaining -= deltaSeconds;
      if (item.remaining > 0) continue;
      const tailDirection = normalize(
        subtract(this.body.tail, this.body.nodes[this.body.nodes.length - 2].position),
        { x: -1, y: 0 }
      );
      const position = add(this.body.tail, scale(tailDirection, 14));
      this.droppings.push({
        id: item.matter.id,
        position,
        velocity: {
          x: tailDirection.x * 18 + this.random.signed() * 5,
          y: 18 + this.random.between(0, 8),
        },
        matter: item.matter,
        age: 0,
      });
      this.brain.onPoop(0.45 + item.matter.nutrition * 0.12);
      this.stomach.splice(index, 1);
    }
  }

  private updateParticles(deltaSeconds: number) {
    for (let index = this.particles.length - 1; index >= 0; index -= 1) {
      const particle = this.particles[index];
      particle.age += deltaSeconds;
      if (particle.age >= particle.lifetime) {
        this.particles.splice(index, 1);
        continue;
      }
      particle.velocity.y += 34 * deltaSeconds;
      particle.position = add(particle.position, scale(particle.velocity, deltaSeconds));
      particle.velocity = scale(particle.velocity, Math.pow(0.985, deltaSeconds * 60));
    }
  }

  private updateDroppings(deltaSeconds: number, bounds: Rect) {
    for (const dropping of this.droppings) {
      dropping.age += deltaSeconds;
      dropping.velocity.y += 38 * deltaSeconds;
      dropping.position = add(dropping.position, scale(dropping.velocity, deltaSeconds));
      dropping.velocity = scale(dropping.velocity, Math.pow(0.91, deltaSeconds * 60));
      const floor = bounds.y + bounds.height - 24;
      if (dropping.position.y > floor) {
        dropping.position.y = floor;
        dropping.velocity.y *= -0.15;
      }
      dropping.position.x = clamp(dropping.position.x, 20, bounds.width - 20);
    }
  }

  private updatePulses(deltaSeconds: number) {
    for (let index = this.pulses.length - 1; index >= 0; index -= 1) {
      this.pulses[index].age += deltaSeconds;
      if (this.pulses[index].age > 0.82) this.pulses.splice(index, 1);
    }
  }

  private spawnCrumb(food: EdibleCode) {
    const source = centerOf(food.rect);
    const glyphs = [...food.text.trim()];
    const glyph = glyphs.length > 0 ? this.random.pick(glyphs) : ".";
    const towardHead = normalize(subtract(this.body.head, source));
    this.particles.push({
      position: {
        x: source.x + this.random.signed() * food.rect.width * 0.28,
        y: source.y + this.random.signed() * 5,
      },
      velocity: add(scale(towardHead, 42), {
        x: this.random.signed() * 14,
        y: this.random.between(-22, -8),
      }),
      age: 0,
      lifetime: 0.72,
      glyph,
      color: food.kind === "comment" ? "#6b746a" : "#008000",
    });
  }

  private spawnBurst(position: Vec2, text: string, color: string, count: number) {
    const glyphs = [...text.trim()];
    for (let index = 0; index < count; index += 1) {
      const angle = this.random.between(0, Math.PI * 2);
      const speed = this.random.between(18, 72);
      this.particles.push({
        position: { ...position },
        velocity: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed - 12 },
        age: 0,
        lifetime: this.random.between(0.5, 1.1),
        glyph: glyphs.length > 0 ? this.random.pick(glyphs) : ".",
        color,
      });
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
