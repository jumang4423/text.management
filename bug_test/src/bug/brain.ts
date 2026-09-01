import {
  add,
  centerOf,
  clamp,
  distance,
  exponentialApproach,
  normalize,
  Random,
  scale,
  subtract,
  type Vec2,
} from "./math";
import type {
  Behaviour,
  BrainDecision,
  BrainSenses,
  CreatureVitals,
  EdibleCode,
} from "./types";

interface BehaviourDrive {
  behaviour: Behaviour;
  strength: number;
}

export class CaterpillarBrain {
  hunger = 0.67;
  energy = 0.82;
  fear = 0;
  curiosity = 0.68;
  fatigue = 0.12;
  gut = 0;
  behaviour: Behaviour = "hatching";
  targetFoodId: string | null = null;

  private readonly random = new Random(0xc0deba5e);
  private age = 0;
  private behaviourAge = 0;
  private wanderTarget: Vec2 | null = null;
  private wanderExpiresAt = 0;
  private currentDrive = 0;
  private habituation = 0;
  private lastStimulusAt = -Infinity;
  private lastThreatPosition: Vec2 | null = null;
  private satisfaction = 0;
  private pointerArrived = false;

  update(senses: BrainSenses): BrainDecision {
    const dt = senses.deltaSeconds;
    this.age += dt;
    this.behaviourAge += dt;
    this.hunger = clamp(this.hunger + dt * (0.0105 + this.energy * 0.0025));
    this.fatigue = clamp(
      this.fatigue +
        dt *
          (this.behaviour === "sleeping"
            ? -0.2
            : this.behaviour === "fleeing"
              ? 0.04
              : 0.008)
    );
    this.energy = clamp(
      this.energy +
        dt *
          (this.behaviour === "sleeping"
            ? 0.13
            : this.behaviour === "fleeing"
              ? -0.035
              : -0.004)
    );
    this.fear = clamp(this.fear - dt * (0.34 + this.habituation * 0.2));
    this.habituation = clamp(this.habituation - dt * 0.045);
    this.satisfaction = clamp(this.satisfaction - dt * 0.12);

    this.readStimulus(senses);

    const pointerDistance = senses.pointer.active
      ? distance(senses.pointer.position, senses.head)
      : Infinity;
    // Pointer-follow test mode: this branch intentionally outranks hatching,
    // chewing, hunger, fear and every autonomous behaviour.
    if (senses.pointer.active) {
      this.switchBehaviour("investigating", 2);
      this.targetFoodId = null;
      if (this.pointerArrived) {
        if (pointerDistance > 96) this.pointerArrived = false;
      } else if (pointerDistance < 72) {
        this.pointerArrived = true;
      }
      const direction = normalize(
        subtract(senses.pointer.position, senses.head),
        { x: 1, y: 0 }
      );
      const decision = this.decisionFor(senses, direction, 2);
      // Chase at one cruise speed. A hysteretic arrival zone replaces the old
      // distance multiplier, which visibly accelerated and decelerated the bug.
      if (this.pointerArrived) decision.control.speed = 0;
      return decision;
    }
    this.pointerArrived = false;

    if (this.age < 0.65) {
      this.behaviour = "hatching";
      return this.decisionFor(senses, { x: 1, y: 0 }, 0);
    }

    if (senses.chewing) {
      this.switchBehaviour("chewing", 2);
      const target = senses.foods.find((food) => food.id === this.targetFoodId);
      const direction = target
        ? normalize(subtract(centerOf(target.rect), senses.head))
        : { x: 1, y: 0 };
      return this.decisionFor(senses, direction, 2);
    }

    if (this.behaviour === "investigating") {
      this.switchBehaviour("wandering", 0.45);
    }

    const targetFood = this.chooseFood(senses.foods, senses.head);
    const drives: BehaviourDrive[] = [
      {
        behaviour: "fleeing",
        strength:
          this.fear * 1.65 +
          (pointerDistance < 90 && senses.pointer.speed > 360 ? 0.7 : 0),
      },
      {
        behaviour: "sleeping",
        strength:
          this.fatigue * 0.9 +
          (1 - this.energy) * 0.75 -
          this.fear * 1.4 -
          this.hunger * 0.25,
      },
      {
        behaviour: "foraging",
        strength:
          (targetFood
            ? this.hunger * this.hunger * (0.65 + targetFood.nutrition * 0.5) *
              (1 - targetFood.heat * 0.82)
            : 0) - this.fear * 0.75,
      },
      {
        behaviour: "investigating",
        strength: 0,
      },
      {
        behaviour: "wandering",
        strength: 0.38 + this.curiosity * 0.25 + this.satisfaction * 0.15,
      },
    ];

    drives.sort((left, right) => right.strength - left.strength);
    const winner = drives[0];
    if (
      winner.behaviour !== this.behaviour &&
      (winner.strength > this.currentDrive + 0.1 || this.behaviourAge > 2.8)
    ) {
      this.switchBehaviour(winner.behaviour, winner.strength);
    } else {
      this.currentDrive +=
        (winner.behaviour === this.behaviour ? winner.strength : this.currentDrive) *
        exponentialApproach(2, dt) -
        this.currentDrive * exponentialApproach(2, dt);
    }

    let direction: Vec2;
    switch (this.behaviour) {
      case "foraging": {
        if (targetFood) {
          this.targetFoodId = targetFood.id;
          direction = normalize(subtract(centerOf(targetFood.rect), senses.head));
        } else {
          this.targetFoodId = null;
          direction = this.wanderDirection(senses);
        }
        break;
      }
      case "investigating": {
        this.targetFoodId = null;
        direction = normalize(subtract(senses.pointer.position, senses.head));
        break;
      }
      case "fleeing": {
        this.targetFoodId = null;
        const threat = this.lastThreatPosition ?? senses.pointer.position;
        direction = normalize(subtract(senses.head, threat));
        break;
      }
      case "sleeping": {
        this.targetFoodId = null;
        direction = { x: 1, y: 0 };
        break;
      }
      default: {
        this.targetFoodId = null;
        direction = this.wanderDirection(senses);
      }
    }

    return this.decisionFor(senses, direction, winner.strength);
  }

  startle(position: Vec2, strength: number, now: number) {
    const repeatedQuickly = now - this.lastStimulusAt < 900;
    this.habituation = clamp(
      this.habituation + (repeatedQuickly ? 0.18 : -0.1)
    );
    const effectiveStrength = strength * (1 - this.habituation * 0.72);
    this.fear = clamp(this.fear + effectiveStrength * 0.8);
    this.lastStimulusAt = now;
    this.lastThreatPosition = { ...position };
  }

  onEat(nutrition: number) {
    this.hunger = clamp(this.hunger - (0.32 + nutrition * 0.2));
    this.energy = clamp(this.energy + 0.12 + nutrition * 0.08);
    this.gut = clamp(this.gut + 0.42 + nutrition * 0.16);
    this.satisfaction = 1;
    this.targetFoodId = null;
    this.switchBehaviour("wandering", 0.65);
  }

  onPoop(amount = 0.48) {
    this.gut = clamp(this.gut - amount);
    this.curiosity = clamp(this.curiosity + 0.08);
  }

  starve() {
    this.hunger = 0.98;
    this.fatigue = Math.min(this.fatigue, 0.35);
    this.fear = 0;
  }

  reset() {
    this.hunger = 0.67;
    this.energy = 0.82;
    this.fear = 0;
    this.curiosity = 0.68;
    this.fatigue = 0.12;
    this.gut = 0;
    this.age = 0;
    this.behaviour = "hatching";
    this.behaviourAge = 0;
    this.currentDrive = 0;
    this.targetFoodId = null;
    this.wanderTarget = null;
    this.lastThreatPosition = null;
    this.satisfaction = 0;
    this.pointerArrived = false;
  }

  vitals(): CreatureVitals {
    return {
      behaviour: this.behaviour,
      hunger: this.hunger,
      energy: this.energy,
      fear: this.fear,
      curiosity: this.curiosity,
      fatigue: this.fatigue,
      gut: this.gut,
    };
  }

  private readStimulus(senses: BrainSenses) {
    const stimulus = senses.stimulus;
    if (!stimulus || stimulus.age > 0.16) return;
    this.startle(
      stimulus.position,
      stimulus.strength * stimulus.surprise,
      senses.now
    );
  }

  private chooseFood(foods: EdibleCode[], head: Vec2) {
    let best: EdibleCode | null = null;
    let bestScore = -Infinity;

    for (const food of foods) {
      const foodDistance = distance(centerOf(food.rect), head);
      const persistenceBonus = food.id === this.targetFoodId ? 0.34 : 0;
      const kindPreference =
        food.kind === "comment" ? 0.18 : food.kind === "modifier" ? 0.1 : 0;
      const score =
        food.nutrition * 0.62 +
        kindPreference +
        persistenceBonus -
        foodDistance / 680 -
        food.heat * 0.88;
      if (score > bestScore) {
        best = food;
        bestScore = score;
      }
    }

    return best;
  }

  private wanderDirection(senses: BrainSenses) {
    const targetExpired = senses.now >= this.wanderExpiresAt;
    const closeToTarget =
      this.wanderTarget !== null && distance(this.wanderTarget, senses.head) < 42;
    if (!this.wanderTarget || targetExpired || closeToTarget) {
      const margin = 54;
      this.wanderTarget = {
        x:
          senses.bounds.x +
          margin +
          this.random.next() * Math.max(1, senses.bounds.width - margin * 2),
        y:
          senses.bounds.y +
          margin +
          this.random.next() * Math.max(1, senses.bounds.height - margin * 2),
      };
      this.wanderExpiresAt = senses.now + this.random.between(2_000, 5_200);
    }
    const drift = {
      x: this.random.signed() * 0.07,
      y: this.random.signed() * 0.07,
    };
    return normalize(add(subtract(this.wanderTarget, senses.head), scale(drift, 80)));
  }

  private decisionFor(
    senses: BrainSenses,
    direction: Vec2,
    drive: number
  ): BrainDecision {
    const fearBoost = this.fear * 170;
    const speedByBehaviour: Record<Behaviour, number> = {
      hatching: 0,
      wandering: 110,
      investigating: 130,
      foraging: 142,
      chewing: 18,
      fleeing: 235,
      sleeping: 0,
    };
    const speed = speedByBehaviour[this.behaviour] + fearBoost;
    const sleep = this.behaviour === "sleeping" ? 1 : 0;
    const gaitHz =
      this.behaviour === "fleeing"
        ? 7
        : this.behaviour === "foraging"
          ? 5.2
          : this.behaviour === "chewing"
            ? 6
            : 3.8 + this.energy * 1.2;

    this.currentDrive +=
      (drive - this.currentDrive) * exponentialApproach(3, senses.deltaSeconds);

    return {
      behaviour: this.behaviour,
      targetFoodId: this.targetFoodId,
      control: {
        direction,
        speed,
        gaitHz,
        wriggle:
          this.behaviour === "sleeping"
            ? 0.08
            : 0.55 + this.fear * 1.8 + this.satisfaction * 0.35,
        sleep,
        fear: this.fear,
        gut: this.gut,
      },
    };
  }

  private switchBehaviour(behaviour: Behaviour, drive: number) {
    if (behaviour === this.behaviour) return;
    this.behaviour = behaviour;
    this.behaviourAge = 0;
    this.currentDrive = drive;
  }
}
