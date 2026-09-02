import {
  centerOf,
  clamp,
  closestPointOnRect,
  distance,
  normalize,
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
const POINTER_DANGER_RADIUS = 180;
const POINTER_SAFE_RADIUS = 460;
const HUNGRY_THRESHOLD = 0.78;

export class CaterpillarBrain {
  hunger = 0.67;
  behaviour: Behaviour = "hatching";
  targetFoodId: string | null = null;

  private readonly random = new Random(0xc0deba5e);
  private age = 0;
  private restRemaining = 0;
  private roamTarget: Vec2 | null = null;
  private pointerThreatened = false;

  update(senses: BrainSenses): BrainDecision {
    const deltaSeconds = senses.deltaSeconds;
    this.age += deltaSeconds;
    this.hunger = clamp(this.hunger + deltaSeconds * 0.032);

    if (this.pointerIsThreatening(senses)) {
      this.behaviour = "fleeing";
      this.targetFoodId = null;
      const direction = normalize(
        subtract(senses.head, senses.pointer.position),
        { x: 1, y: 0 }
      );
      return this.decision(direction);
    }

    if (this.age < HATCH_SECONDS) {
      this.behaviour = "hatching";
      return this.decision({ x: 1, y: 0 });
    }

    if (this.behaviour === "fleeing" || this.behaviour === "hatching") {
      this.beginRest();
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

    if (this.hunger >= HUNGRY_THRESHOLD) {
      const food = this.chooseFood(senses.foods, senses.head);
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
        const approach = clamp((foodDistance - 20) / 140);
        const approachSpeed = 18 + approach * 124;
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
      this.beginRoam(senses.bounds);
    }

    if (!this.roamTarget || !this.targetInside(this.roamTarget, senses.bounds)) {
      this.beginRoam(senses.bounds);
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

  onEat(nutrition: number) {
    this.hunger = clamp(this.hunger - (0.46 + nutrition * 0.18));
    this.targetFoodId = null;
    this.beginRest();
  }

  onPoop() {
    this.beginRest();
  }

  starve() {
    this.hunger = 0.98;
  }

  reset() {
    this.hunger = 0.67;
    this.age = 0;
    this.behaviour = "hatching";
    this.targetFoodId = null;
    this.restRemaining = 0;
    this.roamTarget = null;
    this.pointerThreatened = false;
  }

  vitals(): CreatureVitals {
    return {
      behaviour: this.behaviour,
      hunger: this.hunger,
    };
  }

  private pointerIsThreatening(senses: BrainSenses) {
    if (!senses.pointer.active) {
      this.pointerThreatened = false;
      return false;
    }

    const pointerDistance = distance(senses.pointer.position, senses.head);
    if (this.pointerThreatened) {
      if (pointerDistance > POINTER_SAFE_RADIUS) this.pointerThreatened = false;
    } else if (pointerDistance < POINTER_DANGER_RADIUS) {
      this.pointerThreatened = true;
    }
    return this.pointerThreatened;
  }

  private chooseFood(foods: EdibleCode[], head: Vec2) {
    const current = foods.find((food) => food.id === this.targetFoodId);
    if (current) return current;

    let nearest: EdibleCode | null = null;
    let nearestDistance = Infinity;
    for (const food of foods) {
      const foodDistance = distance(closestPointOnRect(head, food.rect), head);
      if (foodDistance >= nearestDistance) continue;
      nearest = food;
      nearestDistance = foodDistance;
    }
    return nearest;
  }

  private beginRest() {
    this.behaviour = "resting";
    this.restRemaining = this.random.between(
      REST_SECONDS_MIN,
      REST_SECONDS_MAX
    );
    this.roamTarget = null;
  }

  private beginRoam(bounds: Rect) {
    const margin = Math.max(
      24,
      Math.min(78, bounds.width * 0.2, bounds.height * 0.2)
    );
    const availableWidth = Math.max(1, bounds.width - margin * 2);
    const availableHeight = Math.max(1, bounds.height - margin * 2);
    this.roamTarget = {
      x: bounds.x + margin + this.random.next() * availableWidth,
      y: bounds.y + margin + this.random.next() * availableHeight,
    };
    this.behaviour = "wandering";
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
      wandering: 110,
      foraging: 142,
      chewing: 18,
      toileting: 122,
      fleeing: 310,
    };
    const gaitByBehaviour: Record<Behaviour, number> = {
      hatching: 0.7,
      resting: 0.7,
      wandering: 4.2,
      foraging: 5.2,
      chewing: 6,
      toileting: 4.4,
      fleeing: 8.5,
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
