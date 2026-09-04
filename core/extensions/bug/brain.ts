import {
  centerOf,
  clamp,
  closestPointOnRect,
  distance,
  exponentialApproach,
  lerp,
  normalize,
  perpendicular,
  Random,
  subtract,
  type Rect,
  type Vec2,
} from "./math";
import type {
  Behaviour,
  BrainDecision,
  BrainSenses,
  CreatureVitals,
  EdibleCode,
} from "./types";

const HATCH_SECONDS = 0.65;
const REST_SECONDS_MIN = 2;
const REST_SECONDS_MAX = 8;
const ROAM_ARRIVAL_RADIUS = 52;
export const BUG_POINTER_CONTACT_RADIUS = 72;
const FLEE_ARRIVAL_RADIUS = 48;
const FLEE_TIMEOUT_SECONDS = 2.6;
const HUNGRY_THRESHOLD = 0.78;
const STARTLED_APPETITE_DROP = 0.06;
const BASE_HUNGER_PER_SECOND = (0.032 / 3) * 1.4 * 1.5;
const HUNGER_RATE_MIN = 0.65;
const HUNGER_RATE_MAX = 1.45;
const INITIAL_HUNGER_MIN = 0.63;
const INITIAL_HUNGER_MAX = 0.71;
const RECENT_FOOD_LIMIT = 8;
const RECENT_FOOD_RADIUS = 72;
const ACTIVE_LINE_CLEARANCE = 118;
const ACTIVE_LINE_FOOD_CLEARANCE = 68;
const CRUISE_SPEED_MIN = 40;
const CRUISE_SPEED_MAX = 150;
const INITIAL_CRUISE_SPEED = 105;

interface RecentFood {
  from: number;
  text: string;
}

export class CaterpillarBrain {
  hunger: number;
  behaviour: Behaviour = "hatching";
  targetFoodId: string | null = null;

  private readonly random: Random;
  private readonly initialHunger: number;
  private readonly hungerPerSecond: number;
  private readonly recentFoods: RecentFood[] = [];
  private age = 0;
  private restRemaining = 0;
  private roamTarget: Vec2 | null = null;
  private fleeTarget: Vec2 | null = null;
  private fleeRemaining = 0;
  private cruiseSpeed = INITIAL_CRUISE_SPEED;
  private cruiseSpeedTarget = INITIAL_CRUISE_SPEED;
  private cruiseMoodRemaining = 0;

  constructor(randomSeed = 0xc0deba5e) {
    this.random = new Random(randomSeed);
    // Personality has its own deterministic random stream, so changing an
    // individual's metabolism does not also change all of its route choices.
    const personality = new Random(randomSeed ^ 0x4d455441);
    this.initialHunger = personality.between(
      INITIAL_HUNGER_MIN,
      INITIAL_HUNGER_MAX
    );
    this.hungerPerSecond =
      BASE_HUNGER_PER_SECOND *
      personality.between(HUNGER_RATE_MIN, HUNGER_RATE_MAX);
    this.hunger = this.initialHunger;
  }

  update(senses: BrainSenses): BrainDecision {
    const deltaSeconds = senses.deltaSeconds;
    this.age += deltaSeconds;
    this.hunger = clamp(this.hunger + deltaSeconds * this.hungerPerSecond);
    this.updateCruiseSpeed(deltaSeconds);

    const pointerDanger =
      senses.pointer.active &&
      distance(senses.head, senses.pointer.position) <
        BUG_POINTER_CONTACT_RADIUS;
    if (
      pointerDanger &&
      (!this.fleeTarget ||
        !this.targetInside(this.fleeTarget, senses.bounds) ||
        distance(this.fleeTarget, senses.head) <= FLEE_ARRIVAL_RADIUS)
    ) {
      this.beginFlee(senses);
    }

    if (this.fleeTarget) {
      this.fleeRemaining -= deltaSeconds;
      const arrived =
        distance(this.fleeTarget, senses.head) <= FLEE_ARRIVAL_RADIUS;
      const expired = this.fleeRemaining <= 0;
      if ((arrived || expired) && pointerDanger) {
        // A cursor that follows the animal starts a fresh, coherent escape.
        // It never steers directly away from every individual pointer event.
        this.beginFlee(senses);
      } else if (
        arrived ||
        expired ||
        !this.targetInside(this.fleeTarget, senses.bounds)
      ) {
        this.fleeTarget = null;
      }

      if (this.fleeTarget) {
        this.behaviour = "fleeing";
        this.targetFoodId = null;
        return this.decision(
          normalize(subtract(this.fleeTarget, senses.head), { x: 1, y: 0 })
        );
      }
    }

    if (this.age < HATCH_SECONDS) {
      this.behaviour = "hatching";
      return this.decision({ x: 1, y: 0 });
    }

    if (this.behaviour === "hatching") {
      // The hatch itself is already a stationary beat, so start the first roam
      // immediately and choose a destination away from the active code line.
      this.beginRoam(senses.bounds, senses.activeLineRect, senses.head);
    } else if (this.behaviour === "fleeing") {
      // Leaving the pointer's danger radius must not look like the pointer
      // switched locomotion off. Resume roaming; ordinary arrival still owns
      // the deliberate 2-8 second rests.
      this.beginRoam(senses.bounds, senses.activeLineRect, senses.head);
    }

    if (senses.chewing) {
      this.behaviour = "chewing";
      const target = senses.foods.find(
        (food) => food.id === this.targetFoodId
      );
      const direction = target
        ? normalize(subtract(centerOf(target.rect), senses.head))
        : { x: 1, y: 0 };
      return this.decision(direction);
    }

    if (senses.toiletTarget) {
      this.behaviour = "toileting";
      this.targetFoodId = null;
      this.roamTarget = null;
      const toiletDistance = distance(senses.toiletTarget, senses.head);
      const approach = clamp((toiletDistance - 24) / 150);
      return this.decision(
        normalize(subtract(senses.toiletTarget, senses.head)),
        20 + approach * 102
      );
    }

    const activeLineDistance = senses.activeLineRect
      ? distance(
          senses.head,
          closestPointOnRect(senses.head, senses.activeLineRect)
        )
      : Infinity;
    if (
      (this.behaviour === "resting" || this.behaviour === "wandering") &&
      activeLineDistance < ACTIVE_LINE_CLEARANCE
    ) {
      // Crossing the active line is fine; stopping in front of it is not.
      this.beginRoam(senses.bounds, senses.activeLineRect, senses.head);
    }

    if (this.hunger >= HUNGRY_THRESHOLD) {
      const foodsAwayFromActiveLine = senses.activeLineRect
        ? senses.foods.filter(
            (food) =>
              this.rectDistance(food.rect, senses.activeLineRect!) >=
              ACTIVE_LINE_FOOD_CLEARANCE
          )
        : senses.foods;
      const food = this.chooseFood(foodsAwayFromActiveLine, senses.head);
      if (food) {
        this.behaviour = "foraging";
        this.targetFoodId = food.id;
        this.roamTarget = null;
        // Aim for the nearest point on the glyph range, not its centre. A long
        // token or comment should be edible as soon as the mouth reaches any
        // part of it; chasing its centre creates an unnecessary orbit.
        const bitePoint = closestPointOnRect(senses.head, food.rect);
        const foodDistance = distance(bitePoint, senses.head);
        // Full cruise speed has a larger turning radius than the mouth. Slow
        // only for the final approach so pure pursuit cannot orbit forever.
        const approach = clamp((foodDistance - 12) / 92);
        const approachSpeed = 62 + approach * (this.cruiseSpeed - 62);
        return this.decision(
          normalize(subtract(bitePoint, senses.head)),
          approachSpeed
        );
      }
    }

    this.targetFoodId = null;
    if (this.behaviour === "foraging" || this.behaviour === "chewing") {
      this.beginRest();
    }

    if (this.behaviour === "resting") {
      this.restRemaining -= deltaSeconds;
      if (this.restRemaining > 0) return this.decision({ x: 1, y: 0 });
      this.beginRoam(senses.bounds, senses.activeLineRect, senses.head);
    }

    if (!this.roamTarget || !this.targetInside(this.roamTarget, senses.bounds)) {
      this.beginRoam(senses.bounds, senses.activeLineRect, senses.head);
    }
    const roamTarget = this.roamTarget;
    if (!roamTarget) {
      this.beginRest();
      return this.decision({ x: 1, y: 0 });
    }

    if (distance(roamTarget, senses.head) <= ROAM_ARRIVAL_RADIUS) {
      this.beginRest();
      return this.decision({ x: 1, y: 0 });
    }

    this.behaviour = "wandering";
    return this.decision(
      normalize(subtract(roamTarget, senses.head), { x: 1, y: 0 })
    );
  }

  onEat(nutrition: number, food?: EdibleCode) {
    this.hunger = clamp(this.hunger - (0.46 + nutrition * 0.18));
    if (food) {
      this.recentFoods.unshift({
        from: food.from,
        text: food.text.trim().toLowerCase(),
      });
      this.recentFoods.splice(RECENT_FOOD_LIMIT);
    }
    this.targetFoodId = null;
    this.beginRest();
  }

  onBiteMiss() {
    this.targetFoodId = null;
    this.beginRest();
  }

  onMealInterrupted() {
    // A close threat briefly suppresses appetite. Hunger then resumes rising
    // at the normal personal metabolism rate after the creature escapes.
    this.hunger = clamp(this.hunger - STARTLED_APPETITE_DROP);
    this.targetFoodId = null;
  }

  onPoop(
    head: Vec2,
    travelDirection: Vec2,
    bounds: Rect,
    activeLineRect: Rect | null
  ) {
    const forward = normalize(travelDirection, { x: 1, y: 0 });
    const sideways = perpendicular(forward);
    const margin = Math.max(
      28,
      Math.min(92, bounds.width * 0.18, bounds.height * 0.18)
    );
    const candidates = ([-1, 1] as const).map((side) => ({
      x: clamp(
        head.x + sideways.x * side * 190 + forward.x * 36,
        bounds.x + margin,
        bounds.x + bounds.width - margin
      ),
      y: clamp(
        head.y + sideways.y * side * 190 + forward.y * 36,
        bounds.y + margin,
        bounds.y + bounds.height - margin
      ),
    }));
    this.roamTarget = candidates.reduce((best, candidate) => {
      if (!activeLineRect) {
        return this.random.next() < 0.5 ? candidate : best;
      }
      const candidateDistance = this.rectDistance(
        { x: candidate.x, y: candidate.y, width: 1, height: 1 },
        activeLineRect
      );
      const bestDistance = this.rectDistance(
        { x: best.x, y: best.y, width: 1, height: 1 },
        activeLineRect
      );
      return candidateDistance > bestDistance ? candidate : best;
    });
    this.restRemaining = 0;
    this.behaviour = "wandering";
  }

  starve() {
    this.hunger = 0.98;
  }

  reset() {
    this.hunger = this.initialHunger;
    this.age = 0;
    this.behaviour = "hatching";
    this.targetFoodId = null;
    this.restRemaining = 0;
    this.roamTarget = null;
    this.fleeTarget = null;
    this.fleeRemaining = 0;
    this.cruiseSpeed = INITIAL_CRUISE_SPEED;
    this.cruiseSpeedTarget = INITIAL_CRUISE_SPEED;
    this.cruiseMoodRemaining = 0;
    this.recentFoods.length = 0;
  }

  vitals(): CreatureVitals {
    return {
      behaviour: this.behaviour,
      hunger: this.hunger,
    };
  }

  private beginFlee(senses: BrainSenses) {
    const margin = Math.max(
      24,
      Math.min(72, senses.bounds.width * 0.16, senses.bounds.height * 0.16)
    );
    const left = senses.bounds.x + margin;
    const right = Math.max(left, senses.bounds.x + senses.bounds.width - margin);
    const top = senses.bounds.y + margin;
    const bottom = Math.max(top, senses.bounds.y + senses.bounds.height - margin);
    const middleX = (left + right) * 0.5;
    const middleY = (top + bottom) * 0.5;
    const candidates: Vec2[] = [
      { x: left, y: top },
      { x: middleX, y: top },
      { x: right, y: top },
      { x: left, y: middleY },
      { x: right, y: middleY },
      { x: left, y: bottom },
      { x: middleX, y: bottom },
      { x: right, y: bottom },
    ];
    const away = normalize(
      subtract(senses.head, senses.pointer.position),
      normalize({ x: this.random.signed(), y: this.random.signed() })
    );
    let best = candidates[0];
    let bestScore = -Infinity;
    for (const candidate of candidates) {
      const travel = subtract(candidate, senses.head);
      const travelDistance = distance(candidate, senses.head);
      const direction = normalize(travel, away);
      const alignment = direction.x * away.x + direction.y * away.y;
      const score =
        distance(candidate, senses.pointer.position) * 1.25 +
        alignment * 180 +
        Math.min(320, travelDistance) * 0.22 +
        this.random.next() * 6;
      if (score <= bestScore) continue;
      best = candidate;
      bestScore = score;
    }
    this.fleeTarget = best;
    this.fleeRemaining = FLEE_TIMEOUT_SECONDS;
    this.roamTarget = null;
    this.behaviour = "fleeing";
  }

  private chooseFood(foods: EdibleCode[], head: Vec2) {
    const current = foods.find((food) => food.id === this.targetFoodId);
    if (current) return current;

    if (foods.length === 0) return null;
    const fresh = foods.filter((food) =>
      this.recentFoods.every((recent, index) => {
        const sameArea = Math.abs(food.from - recent.from) < RECENT_FOOD_RADIUS;
        const sameFunction =
          index < 3 && food.text.trim().toLowerCase() === recent.text;
        return !sameArea && !sameFunction;
      })
    );
    const relaxed = foods.filter(
      (food) =>
        !this.recentFoods[0] ||
        Math.abs(food.from - this.recentFoods[0].from) >=
          RECENT_FOOD_RADIUS * 0.5
    );
    const candidates =
      fresh.length > 0 ? fresh : relaxed.length > 0 ? relaxed : foods;

    // Random selection prevents the nearest token from being chewed forever.
    // A modest distance weight makes the creature traverse the document while
    // keeping nearby functions possible, so movement does not become a rigid
    // farthest-point tour.
    const weights = candidates.map((food) => {
      const foodDistance = distance(closestPointOnRect(head, food.rect), head);
      return 0.65 + Math.min(2.35, foodDistance / 360);
    });
    let pick = this.random.next() * weights.reduce((sum, weight) => sum + weight, 0);
    for (let index = 0; index < candidates.length; index += 1) {
      pick -= weights[index];
      if (pick <= 0) return candidates[index];
    }
    return candidates[candidates.length - 1];
  }

  private beginRest() {
    this.behaviour = "resting";
    this.restRemaining = this.random.between(
      REST_SECONDS_MIN,
      REST_SECONDS_MAX
    );
    this.roamTarget = null;
  }

  private beginRoam(
    bounds: Rect,
    activeLineRect: Rect | null = null,
    origin: Vec2 | null = null
  ) {
    const margin = Math.max(
      24,
      Math.min(78, bounds.width * 0.2, bounds.height * 0.2)
    );
    const availableWidth = Math.max(1, bounds.width - margin * 2);
    const availableHeight = Math.max(1, bounds.height - margin * 2);
    const candidates = Array.from({ length: 10 }, () => ({
      x: bounds.x + margin + this.random.next() * availableWidth,
      y: bounds.y + margin + this.random.next() * availableHeight,
    }));
    this.roamTarget = candidates.reduce((best, candidate) => {
      const activeLineScore = activeLineRect
        ? this.rectDistance(
            { x: candidate.x, y: candidate.y, width: 1, height: 1 },
            activeLineRect
          )
        : 0;
      const travelScore = origin ? Math.min(220, distance(candidate, origin)) : 0;
      const bestActiveLineScore = activeLineRect
        ? this.rectDistance(
            { x: best.x, y: best.y, width: 1, height: 1 },
            activeLineRect
          )
        : 0;
      const bestTravelScore = origin ? Math.min(220, distance(best, origin)) : 0;
      return activeLineScore + travelScore * 0.24 >
        bestActiveLineScore + bestTravelScore * 0.24
        ? candidate
        : best;
    });
    this.behaviour = "wandering";
  }

  private updateCruiseSpeed(deltaSeconds: number) {
    this.cruiseMoodRemaining -= deltaSeconds;
    if (this.cruiseMoodRemaining <= 0) {
      // Ordinary locomotion continually changes tempo instead of returning to
      // one mechanical default speed. Long, eased transitions keep it animal-
      // like without introducing visible stepping.
      this.cruiseSpeedTarget = this.random.between(
        CRUISE_SPEED_MIN,
        CRUISE_SPEED_MAX
      );
      this.cruiseMoodRemaining = this.random.between(1.8, 4.8);
    }
    this.cruiseSpeed = lerp(
      this.cruiseSpeed,
      this.cruiseSpeedTarget,
      exponentialApproach(1.25, deltaSeconds)
    );
  }

  private rectDistance(left: Rect, right: Rect) {
    const horizontal = Math.max(
      right.x - (left.x + left.width),
      left.x - (right.x + right.width),
      0
    );
    const vertical = Math.max(
      right.y - (left.y + left.height),
      left.y - (right.y + right.height),
      0
    );
    return Math.hypot(horizontal, vertical);
  }

  private targetInside(target: Vec2, bounds: Rect) {
    return (
      target.x >= bounds.x &&
      target.x <= bounds.x + bounds.width &&
      target.y >= bounds.y &&
      target.y <= bounds.y + bounds.height
    );
  }

  private decision(direction: Vec2, speedOverride?: number): BrainDecision {
    const speedByBehaviour: Record<Behaviour, number> = {
      hatching: 0,
      resting: 0,
      wandering: this.cruiseSpeed,
      foraging: this.cruiseSpeed,
      chewing: 18,
      toileting: 122,
      fleeing: 220,
    };
    const gaitByBehaviour: Record<Behaviour, number> = {
      hatching: 0.7,
      resting: 0.7,
      wandering: 4.2,
      foraging: 5.2,
      chewing: 6,
      toileting: 4.4,
      fleeing: 6.2,
    };

    return {
      behaviour: this.behaviour,
      targetFoodId: this.targetFoodId,
      control: {
        direction,
        speed: speedOverride ?? speedByBehaviour[this.behaviour],
        gaitHz: gaitByBehaviour[this.behaviour],
        wriggle:
          this.behaviour === "resting"
            ? 0.08
            : this.behaviour === "fleeing"
              ? 1.45
              : 0.55,
        sleep: this.behaviour === "resting" ? 1 : 0,
        fear: this.behaviour === "fleeing" ? 1 : 0,
        gut: 0,
        chew: 0,
        poop: 0,
        // Code can live inside the ordinary 72 px edge buffer. During a bite
        // approach, direct pursuit wins over that soft buffer; the body's hard
        // boundary reflection still prevents it leaving the document.
        edgeAvoidance:
          this.behaviour === "foraging" || this.behaviour === "chewing"
            ? 0
            : 1,
      },
    };
  }
}
