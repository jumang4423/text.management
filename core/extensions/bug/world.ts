import { CaterpillarBody, CREATURE_SIZE_SCALE } from "./body";
import { BUG_BODY_PRESET, BUG_BODY_PRESETS } from "./appearance";
import { BUG_POINTER_CONTACT_RADIUS, CaterpillarBrain } from "./brain";
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
  PoopSoundKind,
  RhythmPulse,
} from "./types";

interface StomachItem {
  matter: EatenMatter;
  remaining: number;
}

interface ChewState {
  foodId: string;
  elapsed: number;
  munchIn: number;
}

interface PoopMission {
  matter: EatenMatter;
  target: Vec2;
  arrivedFor: number;
  settled: boolean;
}

interface CreatureAgent {
  body: CaterpillarBody;
  brain: CaterpillarBrain;
  stomach: StomachItem[];
  chew: ChewState | null;
  forageFoodId: string | null;
  forageBestDistance: number;
  forageStalledFor: number;
  poopMission: PoopMission | null;
  angerBubbleUntil: number;
  musicBubbleAt: number;
  musicBubbleUntil: number;
}

interface RecentBite {
  from: number;
  text: string;
}

const LOCOMOTION_TIME_SCALE = 5;
const CREATURE_COUNT = 1;
const POINTER_CLICK_RADIUS = 22;
const ANGER_BUBBLE_HOLD_MS = 2_000;
const POST_POOP_MUSIC_DELAY_MS = 1_000;
const POST_POOP_MUSIC_HOLD_MS = 2_000;
const TOILET_ARRIVAL_RADIUS = 52;
const POOP_MIN_SPACING = 96;
const POOP_ANIMATION_SECONDS = 1;
const POOP_RETURN_SECONDS = 0.45;
const CHEW_DURATION_SECONDS = 3;
const MUNCH_INTERVAL_SECONDS = 0.2;

export interface BugWorldMetrics extends CreatureVitals {
  foodCount: number;
  target: string | null;
}

export class BugWorld {
  readonly renderer: BugRenderer;
  readonly body: CaterpillarBody;
  readonly bodies: CaterpillarBody[];
  readonly brain: CaterpillarBrain;
  readonly brains: CaterpillarBrain[];

  mode: CreatureMode = "nibble";
  autoPulse = false;
  showScent = true;
  onMetrics: ((metrics: BugWorldMetrics) => void) | null = null;
  onPoopSound: ((kind: PoopSoundKind) => void) | null = null;
  onMunch: (() => void) | null = null;

  private readonly random = new Random(0xb0611fe);
  private readonly droppings: Dropping[] = [];
  private readonly pulses: SoundPulseVisual[] = [];
  private readonly recentBites: RecentBite[] = [];
  private rhythmPulses: RhythmPulse[] = [];
  private readonly agents: CreatureAgent[];
  private snapshot: HabitatSnapshot;
  private pointer: PointerSense = {
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    speed: 0,
    active: false,
  };
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
    this.agents = Array.from({ length: CREATURE_COUNT }, (_, index) => ({
      body: new CaterpillarBody(this.spawnPosition(this.snapshot, index), {
        ...BUG_BODY_PRESETS[BUG_BODY_PRESET],
        randomSeed: 0xb067a11 ^ Math.imul(index + 1, 0x9e3779b1),
      }),
      brain: new CaterpillarBrain(
        0xc0deba5e ^ Math.imul(index + 1, 0x85ebca6b)
      ),
      stomach: [],
      chew: null,
      forageFoodId: null,
      forageBestDistance: Infinity,
      forageStalledFor: 0,
      poopMission: null,
      angerBubbleUntil: 0,
      musicBubbleAt: 0,
      musicBubbleUntil: 0,
    }));
    this.bodies = this.agents.map((agent) => agent.body);
    this.brains = this.agents.map((agent) => agent.brain);
    this.body = this.bodies[0];
    this.brain = this.brains[0];
    this.renderer = new BugRenderer(canvas);
  }

  start() {
    if (this.animationFrame) return;
    this.lastFrameAt = performance.now();
    this.animationFrame = requestAnimationFrame(this.frame);
  }

  pause() {
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.accumulator = 0;
  }

  destroy() {
    this.pause();
    // The owning EditorView is destroyed immediately after the world. Avoid a
    // final CodeMirror dispatch here because its tab has already left layout
    // state by that point.
    for (const agent of this.agents) agent.chew = null;
  }

  reset() {
    this.snapshot = this.habitat.snapshot(performance.now());
    for (const [index, agent] of this.agents.entries()) {
      agent.brain.reset();
      agent.body.reset(this.spawnPosition(this.snapshot, index));
      agent.stomach.length = 0;
      agent.chew = null;
      agent.forageFoodId = null;
      agent.forageBestDistance = Infinity;
      agent.forageStalledFor = 0;
      agent.poopMission = null;
      agent.angerBubbleUntil = 0;
      agent.musicBubbleAt = 0;
      agent.musicBubbleUntil = 0;
    }
    this.droppings.length = 0;
    this.pulses.length = 0;
    this.recentBites.length = 0;
    this.rhythmPulses.length = 0;
    this.syncChewingDecorations();
    this.simulationAge = 0;
  }

  starve() {
    for (const agent of this.agents) agent.brain.starve();
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

  rhythmPulse(pulse: RhythmPulse) {
    const now = performance.now();
    if (now - pulse.startedAt > 620) return;
    this.rhythmPulses = [
      ...this.rhythmPulses.filter(
        ({ startedAt }) => now - startedAt < 620
      ),
      pulse,
    ].slice(-8);
  }

  clearRhythm() {
    this.rhythmPulses.length = 0;
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
    let chewingChanged = false;
    for (const agent of this.agents) {
      if (
        distance(worldPosition, agent.body.head) >=
        BUG_POINTER_CONTACT_RADIUS
      ) {
        continue;
      }
      agent.angerBubbleUntil = Math.max(
        agent.angerBubbleUntil,
        timestamp + ANGER_BUBBLE_HOLD_MS
      );
      // A bite is committed only after the full chew. Disturbing a creature
      // clears only that creature's pending bite.
      if (agent.chew) {
        agent.brain.onMealInterrupted();
        this.stopChewing(agent);
        this.resetForageProgress(agent);
        chewingChanged = true;
      }
    }
    if (chewingChanged) this.syncChewingDecorations();
    this.updateDroppingTouch();
    this.lastPointerAt = timestamp;
  }

  pointerLeave() {
    this.pointer = {
      ...this.pointer,
      speed: 0,
      active: false,
    };
  }

  pointerDown(stagePosition: Vec2) {
    const worldPosition = this.habitat.stageToWorld(stagePosition);
    const dropping = droppingAtPoint(this.droppings, worldPosition);
    if (dropping) return true;

    const touchedIndex = this.bodies.findIndex(
      (body) => distance(worldPosition, body.head) < POINTER_CLICK_RADIUS
    );
    if (touchedIndex >= 0) {
      const agent = this.agents[touchedIndex];
      agent.angerBubbleUntil = Math.max(
        agent.angerBubbleUntil,
        performance.now() + ANGER_BUBBLE_HOLD_MS
      );
      // pointerMove has already registered the threat; the next simulation
      // tick assigns a stable in-bounds flee target. Do not add a second
      // ballistic kick here: the old click impulse fought the planted-leg
      // solver and could leave only the creature canvas stalled.
      return true;
    }
    return false;
  }

  metrics(): BugWorldMetrics {
    const vitals = this.brain.vitals();
    const target = this.targetFood(this.agents[0]);
    return {
      ...vitals,
      foodCount: this.snapshot.edibles.length,
      target: target?.text.trim() ?? null,
    };
  }

  private readonly frame = (now: number) => {
    this.habitat.syncCamera(this.snapshot);
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
      creatures: this.agents.map((agent) => ({
        body: agent.body,
        behaviour: agent.brain.behaviour,
        targetFood: this.showScent ? this.targetFood(agent) : null,
        chewAmount: agent.chew
          ? clamp(agent.chew.elapsed / CHEW_DURATION_SECONDS)
          : 0,
        faceBubble:
          agent.poopMission?.settled
            ? "💨"
            : agent.chew
              ? "🍙"
              : now >= agent.musicBubbleAt && now < agent.musicBubbleUntil
                ? "🎵"
                : now < agent.angerBubbleUntil
                  ? "💢"
                  : null,
      })),
      snapshot: this.snapshot,
      droppings: this.droppings,
      rhythmPulses: this.rhythmPulses,
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
    const growth = Math.min(1, this.simulationAge / 0.65);
    const foodOwners = new Map<string, CreatureAgent>();

    // Preserve existing claims first. If two creatures somehow retained the
    // same stale target, the later one releases it instead of racing the same
    // document range.
    for (const agent of this.agents) {
      const foodId = agent.chew?.foodId ?? agent.brain.targetFoodId;
      if (!foodId) continue;
      if (foodOwners.has(foodId)) {
        this.stopChewing(agent);
        this.resetForageProgress(agent);
        agent.brain.onBiteMiss();
        continue;
      }
      foodOwners.set(foodId, agent);
    }

    for (const [index, agent] of this.agents.entries()) {
      const unclaimedFoods = this.snapshot.edibles.filter((food) => {
        const owner = foodOwners.get(food.id);
        return !owner || owner === agent;
      });
      const globallyFreshFoods = unclaimedFoods.filter((food) =>
        this.recentBites.every((recent, recentIndex) => {
          const sameArea = Math.abs(food.from - recent.from) < 88;
          const sameFunction =
            recentIndex < 5 &&
            food.text.trim().toLowerCase() === recent.text;
          return !sameArea && !sameFunction;
        })
      );
      const availableFoods =
        globallyFreshFoods.length > 0 ? globallyFreshFoods : unclaimedFoods;
      const decision = agent.brain.update({
        now,
        deltaSeconds,
        head: agent.body.head,
        bounds: visibleBounds,
        pointer: this.pointer,
        foods: availableFoods,
        activeLineRect: this.snapshot.activeLineRect,
        chewing: agent.chew !== null,
        toiletTarget: agent.poopMission?.target ?? null,
      });
      if (decision.targetFoodId) foodOwners.set(decision.targetFoodId, agent);

      if (decision.behaviour === "fleeing") {
        agent.angerBubbleUntil = Math.max(
          agent.angerBubbleUntil,
          now + ANGER_BUBBLE_HOLD_MS
        );
        this.stopChewing(agent);
        this.resetForageProgress(agent);
        if (agent.poopMission) {
          // If startled mid-squat, flee first and resume the toilet animation
          // exactly where the creature finishes escaping.
          agent.poopMission.target = { ...agent.body.head };
          agent.poopMission.arrivedFor = 0;
          agent.poopMission.settled = false;
        }
      } else {
        this.updateChewing(agent, deltaSeconds, decision);
      }

      const control = { ...decision.control };
      if (agent.chew && decision.behaviour !== "fleeing") {
        const target = this.targetFood(agent);
        if (target) {
          control.direction = normalize(
            subtract(centerOf(target.rect), agent.body.head)
          );
        }
        control.speed = 0;
        control.gaitHz = 2.8;
        control.wriggle = 0.9;
        control.chew = 1;
      }
      if (agent.poopMission?.settled && decision.behaviour === "toileting") {
        control.speed = 0;
        control.gaitHz = 0.7;
        control.wriggle = 1.1;
        control.sleep = 0;
        control.poop = 1;
      }
      control.gut = clamp(
        agent.stomach.reduce(
          (sum, item) => sum + item.matter.nutrition * 0.16,
          0
        )
      );
      agent.body.growth = growth;
      this.separateCreatures(index, control);
      for (
        let locomotionStep = 0;
        locomotionStep < LOCOMOTION_TIME_SCALE;
        locomotionStep += 1
      ) {
        agent.body.update(deltaSeconds, control, worldBounds);
      }
      this.updateDigestion(
        agent,
        deltaSeconds,
        decision.behaviour,
        visibleBounds
      );
    }

    if (this.snapshotAge >= 1) {
      this.snapshot = this.habitat.snapshot(now);
      this.snapshotAge = 0;
    }
    this.syncChewingDecorations();
    this.updateDroppings(deltaSeconds);
    this.updateDroppingTouch();
    this.updatePulses(deltaSeconds);
    this.pointer.speed *= Math.pow(0.7, deltaSeconds * 60);
  }

  private updateChewing(
    agent: CreatureAgent,
    deltaSeconds: number,
    decision: BrainDecision
  ) {
    const target = this.targetFood(agent, decision.targetFoodId);
    if (!agent.chew && decision.behaviour === "foraging" && target) {
      const bitePoint = closestPointOnRect(agent.body.head, target.rect);
      const mouthDistance = distance(agent.body.head, bitePoint);

      if (agent.forageFoodId !== target.id) {
        agent.forageFoodId = target.id;
        agent.forageBestDistance = mouthDistance;
        agent.forageStalledFor = 0;
      } else if (mouthDistance < agent.forageBestDistance - 1.5) {
        agent.forageBestDistance = mouthDistance;
        agent.forageStalledFor = 0;
      } else {
        agent.forageStalledFor += deltaSeconds;
      }

      // The ordinary trigger is geometric distance to the code rectangle. The
      // second trigger is a narrow deadlock guard: if the mouth has spent over
      // a second circling within one body length, finish the already-visible
      // approach instead of allowing an endless one-sided turn.
      const reachedFood = mouthDistance < 28 * CREATURE_SIZE_SCALE;
      const stalledBesideFood =
        mouthDistance < 48 * CREATURE_SIZE_SCALE &&
        agent.forageStalledFor > 0.72;
      if (reachedFood || stalledBesideFood) {
        agent.chew = { foodId: target.id, elapsed: 0, munchIn: 0 };
        this.resetForageProgress(agent);
      }
    } else if (!agent.chew) {
      this.resetForageProgress(agent);
    }

    if (!agent.chew) return;
    const chewingFood = this.targetFood(agent, agent.chew.foodId);
    if (!chewingFood) {
      this.stopChewing(agent);
      this.resetForageProgress(agent);
      agent.brain.onBiteMiss();
      return;
    }

    agent.chew.elapsed += deltaSeconds;

    // Minecraft-style munching: a bite sound on chew start, then one every
    // MUNCH interval until the chew finishes or is interrupted.
    agent.chew.munchIn -= deltaSeconds;
    if (agent.chew.munchIn <= 0) {
      agent.chew.munchIn += MUNCH_INTERVAL_SECONDS;
      this.onMunch?.();
    }

    if (agent.chew.elapsed < CHEW_DURATION_SECONDS) return;
    let matter: EatenMatter | null = null;
    if (this.mode === "nibble") matter = this.habitat.eat(chewingFood);
    if (matter) {
      agent.stomach.push({
        matter,
        // The item becomes a toilet mission in this same simulation step.
        // Walking a short distance and the butt animation remain visible, but
        // there is no hidden digestion pause after the chew.
        remaining: 0,
      });
      agent.brain.onEat(matter.nutrition, chewingFood);
      this.recentBites.unshift({
        from: chewingFood.from,
        text: chewingFood.text.trim().toLowerCase(),
      });
      this.recentBites.splice(16);
      this.cancelOtherChews(agent);
      this.snapshotAge = 1;
    } else {
      agent.brain.onBiteMiss();
    }
    this.stopChewing(agent);
  }

  private stopChewing(agent: CreatureAgent) {
    agent.chew = null;
  }

  private resetForageProgress(agent: CreatureAgent) {
    agent.forageFoodId = null;
    agent.forageBestDistance = Infinity;
    agent.forageStalledFor = 0;
  }

  private cancelOtherChews(eater: CreatureAgent) {
    for (const agent of this.agents) {
      if (agent === eater || !agent.chew) continue;
      this.stopChewing(agent);
      this.resetForageProgress(agent);
      agent.brain.onBiteMiss();
    }
  }

  private updateDigestion(
    agent: CreatureAgent,
    deltaSeconds: number,
    behaviour: BrainDecision["behaviour"],
    bounds: Rect
  ) {
    for (let index = 0; index < agent.stomach.length; index += 1) {
      const item = agent.stomach[index];
      item.remaining -= deltaSeconds;
    }

    if (!agent.poopMission && !agent.chew) {
      const readyIndex = agent.stomach.findIndex(
        (item) => item.remaining <= 0
      );
      if (readyIndex >= 0) {
        const [ready] = agent.stomach.splice(readyIndex, 1);
        agent.poopMission = {
          matter: ready.matter,
          // Defecate where the bite finished. The target is already under the
          // head, so the next step begins the butt animation without walking.
          target: { ...agent.body.head },
          arrivedFor: 0,
          settled: false,
        };
      }
    }

    const mission = agent.poopMission;
    if (!mission || behaviour !== "toileting") return;
    if (!mission.settled) {
      const targetDistance = distance(agent.body.head, mission.target);
      if (targetDistance > TOILET_ARRIVAL_RADIUS) return;
      mission.settled = true;
      mission.arrivedFor = 0;
      this.onPoopSound?.("wiggle");
    }

    mission.arrivedFor += deltaSeconds;
    if (mission.arrivedFor < POOP_ANIMATION_SECONDS) return;
    const placement = this.clearTailPoopPlacement(agent.body);

    this.droppings.push({
      id: mission.matter.id,
      ...placement,
      matter: mission.matter,
      age: 0,
      size: this.random.between(30, 38),
      rotation: this.random.between(-0.18, 0.18),
      returnProgress: null,
    });
    this.onPoopSound?.("release");
    agent.poopMission = null;
    const musicAt = performance.now() + POST_POOP_MUSIC_DELAY_MS;
    agent.musicBubbleAt = musicAt;
    agent.musicBubbleUntil = musicAt + POST_POOP_MUSIC_HOLD_MS;
    agent.brain.onPoop(
      agent.body.head,
      agent.body.travelDirection,
      bounds,
      this.snapshot.activeLineRect
    );
  }

  private tailPoopPlacement(body: CaterpillarBody) {
    const tailIndex = body.nodes.length - 1;
    const tail = body.renderNodeAt(tailIndex, 1);
    const previous = body.renderNodeAt(Math.max(0, tailIndex - 1), 1);
    const outward = normalize(subtract(tail, previous), { x: -1, y: 0 });
    const tailRadius = body.radiusAt(tailIndex);
    return {
      origin: add(tail, scale(outward, tailRadius * 0.55)),
      position: add(
        tail,
        scale(outward, tailRadius + 20 * CREATURE_SIZE_SCALE)
      ),
    };
  }

  private clearTailPoopPlacement(body: CaterpillarBody) {
    const placement = this.tailPoopPlacement(body);
    if (this.poopSpotIsClear(placement.position)) return placement;

    const tailIndex = body.nodes.length - 1;
    const tail = body.renderNodeAt(tailIndex, 1);
    const previous = body.renderNodeAt(Math.max(0, tailIndex - 1), 1);
    const outward = normalize(subtract(tail, previous), { x: -1, y: 0 });
    const sideways = { x: -outward.y, y: outward.x };
    for (const offset of [54, -54, 104, -104, 154, -154]) {
      const candidate = add(
        placement.position,
        scale(sideways, offset)
      );
      if (!this.poopSpotIsClear(candidate)) continue;
      return { origin: placement.origin, position: candidate };
    }
    return placement;
  }

  private poopSpotIsClear(position: Vec2) {
    return this.droppings.every(
      (dropping) => distance(position, dropping.position) >= POOP_MIN_SPACING
    );
  }

  private updateDroppings(deltaSeconds: number) {
    for (let index = this.droppings.length - 1; index >= 0; index -= 1) {
      const dropping = this.droppings[index];
      dropping.age += deltaSeconds;
      if (dropping.returnProgress === null) continue;

      dropping.returnProgress = clamp(
        dropping.returnProgress + deltaSeconds / POOP_RETURN_SECONDS
      );
      if (dropping.returnProgress < 1) continue;

      this.droppings.splice(index, 1);
    }
  }

  private beginDroppingReturn(dropping: Dropping) {
    if (!dropping.matter || dropping.returnProgress !== null) return;
    if (!this.habitat.restore(dropping.matter)) return;
    dropping.returnProgress = 0;
  }

  private updateDroppingTouch() {
    if (!this.pointer.active) return;
    const dropping = droppingAtPoint(this.droppings, this.pointer.position);
    if (dropping?.returnProgress === null) this.beginDroppingReturn(dropping);
  }

  private updatePulses(deltaSeconds: number) {
    for (let index = this.pulses.length - 1; index >= 0; index -= 1) {
      this.pulses[index].age += deltaSeconds;
      if (this.pulses[index].age > 0.82) this.pulses.splice(index, 1);
    }
  }

  private targetFood(
    agent: CreatureAgent,
    foodId = agent.brain.targetFoodId
  ) {
    if (!foodId) return null;
    return this.snapshot.edibles.find((food) => food.id === foodId) ?? null;
  }

  private syncChewingDecorations() {
    const foods = this.agents.flatMap((agent) => {
      if (!agent.chew) return [];
      const food = this.targetFood(agent, agent.chew.foodId);
      return food ? [food] : [];
    });
    this.habitat.setChewing(foods);
  }

  private separateCreatures(index: number, control: BodyControl) {
    if (control.speed < 0.8) return;
    const body = this.agents[index].body;
    let separation = { x: 0, y: 0 };
    let strongest = 0;
    for (const [otherIndex, other] of this.agents.entries()) {
      if (otherIndex === index) continue;
      const separationDistance = distance(body.head, other.body.head);
      if (separationDistance >= 150) continue;
      const strength = clamp((150 - separationDistance) / 95);
      const away = normalize(
        subtract(body.head, other.body.head),
        body.travelDirection
      );
      separation = add(separation, scale(away, strength));
      strongest = Math.max(strongest, strength);
    }
    if (strongest <= 0) return;
    control.direction = normalize(
      add(control.direction, scale(separation, 0.58)),
      control.direction
    );
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
      (ringIndex / Math.max(1, CREATURE_COUNT - 1)) * Math.PI * 2;
    const radius = ringIndex % 2 === 0 ? 185 : 235;
    return {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    };
  }
}
