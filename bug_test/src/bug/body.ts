import {
  add,
  clamp,
  exponentialApproach,
  lerp,
  lerpVec,
  magnitude,
  normalize,
  perpendicular,
  Random,
  scale,
  smoothstep,
  subtract,
  wrapAngle,
  type Rect,
  type Vec2,
} from "./math";
import type { BodyControl } from "./types";

interface BodyNode {
  position: Vec2;
  previous: Vec2;
}

interface LegFrame {
  root: Vec2;
  tangent: Vec2;
  outward: Vec2;
}

export type LegMode = "stance" | "swing" | "search";

export interface LegJoint {
  angle: number;
  angularVelocity: number;
  targetAngle: number;
  minimum: number;
  maximum: number;
  stiffness: number;
  damping: number;
}

export interface CaterpillarLeg {
  nodeIndex: number;
  side: -1 | 1;
  gaitGroup: 0 | 1;
  stepDirection: Vec2;
  joints: [LegJoint, LegJoint, LegJoint];
  /** Hip, elbow, wrist, hand. */
  points: [Vec2, Vec2, Vec2, Vec2];
  foot: Vec2;
  anchor: Vec2;
  landingTarget: Vec2;
  planted: boolean;
  contact: boolean;
  mode: LegMode;
  modeAge: number;
  stanceAge: number;
  refractory: number;
  touchdownSignal: number;
  load: number;
  grip: number;
  contraction: number;
  contractionVelocity: number;
  plantDistance: number;
  elevation: number;
  elevationVelocity: number;
  elevationTarget: number;
  reflex: number;
  postureBias: number;
  motionScale: number;
  timingBias: number;
  swingQueued: boolean;
  swingDelay: number;
}

export interface CaterpillarBodyOptions {
  segmentCount?: number;
  segmentLength?: number;
  radius?: number;
  randomSeed?: number;
}

// Deliberately oversized: the hands must read as the source of locomotion.
const LEG_LINK_LENGTHS: readonly [number, number, number] = [28, 34, 42];
const LEG_MOTION_TIME_SCALE = 0.5;
const BODY_DRIVE_SCALE = 2;
const CRUISE_SPEED_SCALE = 0.42;
export const MAX_TURN_RATE = 2;
const LEG_JOINT_LIMITS: readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
] = [
  [-1.28, 1.28],
  [-1.62, 1.52],
  [-1.82, 1.52],
];

function dot(left: Vec2, right: Vec2) {
  return left.x * right.x + left.y * right.y;
}

function cross(left: Vec2, right: Vec2) {
  return left.x * right.y - left.y * right.x;
}

function createJoint(
  angle: number,
  limits: readonly [number, number],
  stiffness: number,
  damping: number
): LegJoint {
  return {
    angle,
    angularVelocity: 0,
    targetAngle: angle,
    minimum: limits[0],
    maximum: limits[1],
    stiffness,
    damping,
  };
}

export class CaterpillarBody {
  readonly nodes: BodyNode[];
  readonly legs: CaterpillarLeg[] = [];
  readonly segmentLength: number;
  readonly baseRadius: number;
  growth = 0;
  headingAngle = 0;
  turnRate = 0;
  travelDirection: Vec2 = { x: 1, y: 0 };
  lastControl: BodyControl = {
    direction: { x: 1, y: 0 },
    speed: 0,
    gaitHz: 0.7,
    wriggle: 0,
    sleep: 0,
    fear: 0,
    gut: 0,
  };

  private legsActivated = false;
  private activeStepGroup: 0 | 1 = 0;
  private stepGroupAge = 0;
  private activeGroupHasLanded = false;
  private readonly tractionVelocity: Vec2[];
  private readonly gaitRandom: Random;
  private readonly legTempoScale: number;
  private readonly strideScale: number;
  private readonly liftScale: number;
  private readonly stepStagger: number;
  private readonly curvatureScale: number;
  private readonly headTrail: Vec2[] = [];
  private breathPhase = 0;
  private readonly tissueCompression: number[];
  private readonly tissueVelocity: number[];
  private renderPreviousNodes: Vec2[] = [];
  private renderPreviousLegPoints: Vec2[][] = [];
  private renderPreviousRadii: number[] = [];
  private renderPreviousDirection: Vec2 = { x: 1, y: 0 };

  constructor(
    origin: Vec2,
    {
      segmentCount = 5,
      segmentLength = 32,
      radius = 13,
      randomSeed = 0xb067a11,
    }: CaterpillarBodyOptions = {}
  ) {
    this.segmentLength = segmentLength;
    this.baseRadius = radius;
    this.gaitRandom = new Random(randomSeed);
    // Stable phenotype values make each seeded body recognisable across steps.
    this.legTempoScale = this.gaitRandom.between(0.68, 1.32);
    this.strideScale = this.gaitRandom.between(0.84, 1.16);
    this.liftScale = this.gaitRandom.between(0.78, 1.22);
    this.stepStagger = this.gaitRandom.between(0.035, 0.18);
    this.curvatureScale = this.gaitRandom.between(0.82, 1.22);
    this.nodes = Array.from({ length: segmentCount }, (_, index) => {
      const position = {
        x: origin.x - index * segmentLength * 0.76,
        y: origin.y,
      };
      return { position, previous: { ...position } };
    });
    this.breathPhase = ((randomSeed >>> 0) % 997) / 997;
    this.tissueCompression = this.nodes.map(() => 0);
    this.tissueVelocity = this.nodes.map(() => 0);
    this.tractionVelocity = this.nodes.map(() => ({ x: 0, y: 0 }));
    this.resetHeadTrail();

    // Every white torso disc owns a left/right pair. The grey head stays bare.
    const legNodes = Array.from(
      { length: Math.max(0, segmentCount - 1) },
      (_, index) => index + 1
    );
    for (const [pairIndex, nodeIndex] of legNodes.entries()) {
      for (const side of [-1, 1] as const) {
        const sequence = ((nodeIndex * 3 + (side > 0 ? 2 : 0)) % 7) / 6;
        const postureBias = sequence * 2 - 1;
        const pose = this.neutralPose(postureBias);
        const originPoint = { ...this.nodes[nodeIndex].position };
        const leg: CaterpillarLeg = {
          nodeIndex,
          side,
          gaitGroup: ((pairIndex + (side > 0 ? 1 : 0)) % 2) as 0 | 1,
          stepDirection: { x: 1, y: 0 },
          joints: [
            createJoint(pose[0], LEG_JOINT_LIMITS[0], 330, 27),
            createJoint(pose[1], LEG_JOINT_LIMITS[1], 286, 24),
            createJoint(pose[2], LEG_JOINT_LIMITS[2], 242, 21),
          ],
          points: [
            { ...originPoint },
            { ...originPoint },
            { ...originPoint },
            { ...originPoint },
          ],
          foot: { ...originPoint },
          anchor: { ...originPoint },
          landingTarget: { ...originPoint },
          planted: true,
          contact: true,
          mode: "stance",
          modeAge: 0,
          stanceAge: 0,
          refractory: 0,
          touchdownSignal: 0,
          load: 0,
          grip: 1,
          contraction: 0,
          contractionVelocity: 0,
          plantDistance: 0,
          elevation: 0,
          elevationVelocity: 0,
          elevationTarget: 0,
          reflex: 0,
          postureBias,
          motionScale: this.gaitRandom.between(0.88, 1.12),
          timingBias: this.gaitRandom.next(),
          swingQueued: false,
          swingDelay: 0,
        };
        this.legs.push(leg);
        this.refreshLegGeometry(leg);
        leg.anchor = { ...leg.foot };
        leg.landingTarget = { ...leg.foot };
        leg.plantDistance = magnitude(
          subtract(leg.anchor, this.legFrame(leg).root)
        );
      }
    }
    this.captureRenderPose();
  }

  get head() {
    return this.nodes[0].position;
  }

  get tail() {
    return this.nodes[this.nodes.length - 1].position;
  }

  radiusAt(index: number) {
    const middle = (this.nodes.length - 1) * 0.56;
    const gutBulge =
      this.lastControl.gut *
      0.34 *
      Math.exp(-Math.pow((index - middle) / 1.8, 2));
    const taper = index === 0 ? 1.12 : 1 - (index / this.nodes.length) * 0.2;
    const torsoScale = index === 0 ? 1 : 1.3;
    // Axial compression conserves a little apparent volume: a shortened disc
    // becomes wider, then settles with an under-damped tissue response.
    const tissueScale = clamp(
      1 + (this.tissueCompression[index] ?? 0) * 0.07,
      0.93,
      1.09
    );
    return (
      this.baseRadius *
      taper *
      torsoScale *
      (1 + gutBulge) *
      tissueScale *
      clamp(this.growth, 0.04, 1)
    );
  }

  tangentAt(index: number) {
    const previous = this.nodes[Math.max(0, index - 1)].position;
    const next = this.nodes[Math.min(this.nodes.length - 1, index + 1)].position;
    return normalize(subtract(previous, next), this.desiredForward());
  }

  captureRenderPose() {
    this.renderPreviousNodes = this.nodes.map((node) => ({ ...node.position }));
    this.renderPreviousLegPoints = this.legs.map((leg) =>
      leg.points.map((point) => ({ ...point }))
    );
    this.renderPreviousRadii = this.nodes.map((_, index) => this.radiusAt(index));
    this.renderPreviousDirection = { ...this.travelDirection };
  }

  renderNodeAt(index: number, interpolation: number): Vec2 {
    const current = this.nodes[index]?.position ?? this.head;
    const previous = this.renderPreviousNodes[index] ?? current;
    return lerpVec(previous, current, clamp(interpolation));
  }

  renderLegPointsAt(
    legIndex: number,
    interpolation: number
  ): [Vec2, Vec2, Vec2, Vec2] {
    const current = this.legs[legIndex]?.points;
    if (!current) {
      const head = this.renderNodeAt(0, interpolation);
      return [{ ...head }, { ...head }, { ...head }, { ...head }];
    }
    const previous = this.renderPreviousLegPoints[legIndex] ?? current;
    return current.map((point, pointIndex) =>
      lerpVec(previous[pointIndex] ?? point, point, clamp(interpolation))
    ) as [Vec2, Vec2, Vec2, Vec2];
  }

  renderRadiusAt(index: number, interpolation: number) {
    return lerp(
      this.renderPreviousRadii[index] ?? this.radiusAt(index),
      this.radiusAt(index),
      clamp(interpolation)
    );
  }

  renderTravelDirection(interpolation: number) {
    return normalize(
      lerpVec(
        this.renderPreviousDirection,
        this.travelDirection,
        clamp(interpolation)
      ),
      this.travelDirection
    );
  }

  update(deltaSeconds: number, control: BodyControl, bounds: Rect) {
    this.lastControl = control;
    const requestedDirection = this.wallAwareDirection(
      normalize(control.direction, this.desiredForward()),
      bounds
    );
    const requestedAngle = Math.atan2(requestedDirection.y, requestedDirection.x);
    const headingError = wrapAngle(requestedAngle - this.headingAngle);
    const locomotionPaused = control.speed <= 0.8 || control.sleep >= 0.86;
    if (locomotionPaused) {
      // Arrival is a literal pose hold: do not rotate the torso underneath
      // world-pinned hands and make every limb appear to fold toward the head.
      this.turnRate = 0;
    } else {
      // The head can cut into a tight turn, while bounded angular velocity still
      // prevents an instantaneous whole-body direction flip.
      const requestedTurnRate = clamp(
        headingError * 1.8,
        -MAX_TURN_RATE,
        MAX_TURN_RATE
      );
      this.turnRate = lerp(
        this.turnRate,
        requestedTurnRate,
        exponentialApproach(3.4, deltaSeconds)
      );
      this.headingAngle = wrapAngle(
        this.headingAngle + this.turnRate * deltaSeconds
      );
    }
    const headForward = this.desiredForward();
    this.travelDirection = { ...headForward };

    // No procedural translation and no locomotion oscillator. The body only
    // keeps momentum injected by planted hands, collisions and explicit stimuli.
    const damping = Math.pow(0.56, deltaSeconds * 60);
    for (const node of this.nodes) {
      const velocity = scale(subtract(node.position, node.previous), damping);
      node.previous = { ...node.position };
      node.position = add(node.position, velocity);
    }

    this.solveBodyShape(bounds, 7);
    // Limb articulation runs at half-time. Contact force remains independent
    // and is amplified below, so slow deliberate hands can drive a fast torso.
    this.updateLegs(
      deltaSeconds * LEG_MOTION_TIME_SCALE * this.legTempoScale,
      deltaSeconds,
      control,
      bounds
    );
    this.updateOrganicTissue(deltaSeconds, locomotionPaused);
    this.solveBodyShape(bounds, 6);
    // Apply the recorded head path after the straightening constraints. This
    // leaves a visible shallow arc for the four rear discs instead of having
    // the solver erase the bend immediately.
    if (!locomotionPaused) this.applyHeadTrailShape(deltaSeconds, bounds);
    // Never release the other support group while any hand is already airborne.
    // One complete diagonal group of four planted hands is the invariant.
    const hasAirborneHand = this.legs.some(
      (leg) => leg.mode !== "stance" || leg.swingQueued
    );
    const outsideWorkspace = hasAirborneHand
      ? undefined
      : this.legs.find(
          (leg) =>
            leg.mode === "stance" &&
            leg.stanceAge > 0.12 &&
            this.legAnchorOutsideWorkspace(leg)
        );
    if (outsideWorkspace) {
      // Release the complete group before a planted hand can cross the body,
      // reverse sides or pull a limb beyond its anatomical workspace.
      this.activeStepGroup = outsideWorkspace.gaitGroup;
      this.stepGroupAge = 0;
      this.beginStepGroup(outsideWorkspace.gaitGroup, headForward);
    }
    // Never snap the torso back toward an old anchor: that creates visible
    // stick-slip. Excess load is resolved by an early anatomical step instead.
    this.releaseOverloadedContacts(control, bounds, headForward);
    for (const leg of this.legs) this.refreshLegGeometry(leg);
  }

  impulse(origin: Vec2, strength: number) {
    for (const node of this.nodes) {
      const away = normalize(subtract(node.position, origin), { x: 0, y: -1 });
      const falloff = 1 / Math.max(1, magnitude(subtract(node.position, origin)) / 46);
      node.previous = subtract(node.previous, scale(away, strength * falloff));
    }

    for (const leg of this.legs) {
      const distanceFromImpulse = magnitude(subtract(leg.points[0], origin));
      const kick = clamp((strength / 18) / Math.max(1, distanceFromImpulse / 58));
      leg.reflex = Math.max(leg.reflex, kick);
      leg.joints[0].angularVelocity += leg.postureBias * kick * 1.8;
      leg.joints[1].angularVelocity += kick * 2.7;
      leg.joints[2].angularVelocity -= kick * 3.1;
      leg.elevationVelocity += kick * 2.8;
      if (leg.mode === "stance") leg.grip = clamp(leg.grip + kick * 0.28);
    }
  }

  reset(origin: Vec2) {
    this.growth = 0;
    this.headingAngle = 0;
    this.turnRate = 0;
    this.travelDirection = { x: 1, y: 0 };
    this.legsActivated = false;
    this.activeStepGroup = 0;
    this.stepGroupAge = 0;
    this.activeGroupHasLanded = false;
    this.breathPhase = 0;
    for (const velocity of this.tractionVelocity) {
      velocity.x = 0;
      velocity.y = 0;
    }
    this.tissueCompression.fill(0);
    this.tissueVelocity.fill(0);
    for (let index = 0; index < this.nodes.length; index += 1) {
      const position = {
        x: origin.x - index * this.segmentLength * 0.76,
        y: origin.y,
      };
      this.nodes[index].position = position;
      this.nodes[index].previous = { ...position };
    }
    this.resetHeadTrail();

    for (const leg of this.legs) {
      const pose = this.neutralPose(leg.postureBias);
      for (let index = 0; index < leg.joints.length; index += 1) {
        const joint = leg.joints[index];
        joint.angle = pose[index];
        joint.targetAngle = pose[index];
        joint.angularVelocity = 0;
      }
      leg.mode = "stance";
      leg.modeAge = 0;
      leg.stanceAge = 0;
      leg.refractory = 0;
      leg.touchdownSignal = 0;
      leg.load = 0;
      leg.grip = 1;
      leg.contraction = 0;
      leg.contractionVelocity = 0;
      leg.contact = true;
      leg.planted = true;
      leg.elevation = 0;
      leg.elevationVelocity = 0;
      leg.elevationTarget = 0;
      leg.reflex = 0;
      leg.motionScale = this.gaitRandom.between(0.88, 1.12);
      leg.swingQueued = false;
      leg.swingDelay = 0;
      leg.stepDirection = { x: 1, y: 0 };
      this.refreshLegGeometry(leg);
      leg.anchor = { ...leg.foot };
      leg.landingTarget = { ...leg.foot };
      leg.plantDistance = magnitude(
        subtract(leg.anchor, this.legFrame(leg).root)
      );
    }
    this.captureRenderPose();
  }

  private updateLegs(
    deltaSeconds: number,
    bodyDeltaSeconds: number,
    control: BodyControl,
    bounds: Rect
  ) {
    for (const leg of this.legs) this.refreshLegGeometry(leg);
    const tractionTargets = this.nodes.map(() => ({ x: 0, y: 0 }));

    if (this.growth < 0.5) {
      for (const leg of this.legs) {
        leg.mode = "stance";
        leg.planted = true;
        leg.contact = true;
        leg.anchor = { ...leg.foot };
        leg.landingTarget = { ...leg.foot };
        leg.plantDistance = magnitude(
          subtract(leg.anchor, this.legFrame(leg).root)
        );
        leg.load = 0;
        leg.contraction = 0;
        leg.contractionVelocity = 0;
        leg.swingQueued = false;
        leg.swingDelay = 0;
      }
      this.integrateTraction(tractionTargets, bodyDeltaSeconds);
      return;
    }

    if (!this.legsActivated) this.activateLegs();

    const activity = 1 - control.sleep;
    const headForward = this.desiredForward();
    const locomotionActivity =
      activity * clamp(control.speed / 20);
    if (locomotionActivity <= 0.04) {
      // Freeze the exact current leg phase. Queued lifts, airborne joints and
      // elevation resume from this pose when movement is requested again.
      for (const velocity of this.tractionVelocity) {
        velocity.x = 0;
        velocity.y = 0;
      }
      return;
    }
    if (locomotionActivity > 0.04) this.stepGroupAge += deltaSeconds;

    // The active diagonal group first reaches fixed targets in the route direction.
    // Only touchdown and completed pulling advance the two-group sequence.
    for (const leg of this.legs) {
      if (leg.swingQueued) {
        leg.swingDelay -= deltaSeconds;
        if (leg.swingDelay <= 0) {
          leg.swingQueued = false;
          this.beginSwing(leg, leg.stepDirection, control, bounds);
        }
      }
      leg.modeAge += deltaSeconds;
      leg.stanceAge = leg.mode === "stance" ? leg.stanceAge + deltaSeconds : 0;
      leg.refractory = Math.max(0, leg.refractory - deltaSeconds);
      leg.touchdownSignal *= Math.exp(-8 * deltaSeconds);
      leg.reflex *= Math.exp(-6.2 * deltaSeconds);

      const frame = this.legFrame(leg);
      const totalReach = this.totalLegReach();
      const rootToAnchor = subtract(leg.anchor, frame.root);
      const anchorDistance = magnitude(rootToAnchor);
      const pullTarget = totalReach * (0.44 + Math.abs(leg.postureBias) * 0.02);

      if (leg.mode === "stance") {
        const contractionAcceleration =
          360 * (1 - leg.contraction) - 29 * leg.contractionVelocity;
        leg.contractionVelocity += contractionAcceleration * deltaSeconds;
        leg.contraction = clamp(
          leg.contraction + leg.contractionVelocity * deltaSeconds,
          0,
          1.08
        );
        const contractionAmount = smoothstep(leg.contraction);
        const desiredDistance = lerp(
          Math.max(pullTarget, leg.plantDistance),
          pullTarget,
          contractionAmount
        );
        const stretch = Math.max(0, anchorDistance - desiredDistance);
        const targetLoad = clamp(0.12 + stretch / Math.max(8, totalReach * 0.25));
        leg.load = lerp(
          leg.load,
          targetLoad * leg.grip,
          exponentialApproach(15, deltaSeconds)
        );
        leg.grip = lerp(
          leg.grip,
          1,
          exponentialApproach(12 + leg.load * 8, deltaSeconds)
        );
        leg.contact = true;
        leg.planted = true;
      } else {
        leg.load = lerp(
          leg.load,
          0,
          exponentialApproach(22, deltaSeconds)
        );
        leg.grip = lerp(
          leg.grip,
          0,
          exponentialApproach(19, deltaSeconds)
        );
        leg.contact = false;
        leg.planted = false;

        if (leg.mode === "swing") {
          const handError = magnitude(subtract(leg.foot, leg.landingTarget));
          const reachDeadline = clamp(
            0.09 / (0.8 + control.gaitHz * 0.12),
            0.045,
            0.1
          );
          if (handError < 6 || leg.modeAge > reachDeadline) {
            leg.mode = "search";
            leg.modeAge = 0;
            leg.elevationTarget = 0;
          }
        }
      }
    }

    // Joint motors reach toward the hand target. Planted hands are then pinned
    // exactly in world space, and their shortening muscles pull the torso.
    for (const leg of this.legs) {
      const frame = this.legFrame(leg);
      const desiredHand =
        leg.mode === "stance" ? leg.anchor : leg.landingTarget;
      const solved = this.solveJointTargets(leg, desiredHand, frame);
      const preferred: readonly [number, number, number] =
        leg.mode === "swing"
          ? [0.32, 0.92, -1.14]
          : leg.mode === "search"
            ? [0.28, 0.56, -0.44]
            : this.neutralPose(leg.postureBias);
      const postureWeight = leg.mode === "stance" ? 0.025 : 0.11;
      const legDeltaSeconds = deltaSeconds * leg.motionScale;

      for (let index = 0; index < leg.joints.length; index += 1) {
        const joint = leg.joints[index];
        joint.targetAngle = clamp(
          lerp(solved[index], preferred[index], postureWeight) +
            (index === 1 ? leg.reflex * 0.14 : 0) -
            (index === 2 ? leg.reflex * 0.18 : 0),
          joint.minimum,
          joint.maximum
        );
        this.integrateJoint(joint, legDeltaSeconds, leg);
      }

      const liftAcceleration =
        300 * (leg.elevationTarget - leg.elevation) -
        26 * leg.elevationVelocity;
      leg.elevationVelocity += liftAcceleration * legDeltaSeconds;
      leg.elevationVelocity = clamp(leg.elevationVelocity, -12, 12);
      leg.elevation = clamp(
        leg.elevation + leg.elevationVelocity * legDeltaSeconds,
        0,
        1.12
      );
      if (
        (leg.elevation === 0 && leg.elevationVelocity < 0) ||
        (leg.elevation === 1.12 && leg.elevationVelocity > 0)
      ) {
        leg.elevationVelocity *= -0.14;
      }

      this.refreshLegGeometry(leg);

      if (leg.mode === "search") {
        const handError = magnitude(subtract(leg.foot, leg.landingTarget));
        if (
          leg.modeAge > 0.025 &&
          leg.elevation < 0.28 &&
          handError < 4.5
        ) {
          this.plantLeg(leg);
        } else if (leg.modeAge > 0.24) {
          // A wall can make the ideal ring unreachable. Grip at the hand's
          // actual kinematic position so one missed target cannot deadlock the
          // complete support group. No coordinate is snapped to the ring.
          this.plantLeg(leg);
        }
      }

      if (leg.mode === "stance" && locomotionActivity > 0.02) {
        this.applyHandTraction(
          leg,
          leg.stepDirection,
          locomotionActivity,
          tractionTargets
        );
      }
    }

    const cruiseSpeed =
      locomotionActivity > 0.02
        ? clamp(
            control.speed *
              activity *
              BODY_DRIVE_SCALE *
              CRUISE_SPEED_SCALE,
            0,
            280
          )
        : 0;
    this.integrateTraction(
      tractionTargets,
      bodyDeltaSeconds,
      cruiseSpeed,
      headForward
    );
    this.advanceAlternatingGait(control, activity, headForward);
  }

  private applyHandTraction(
    leg: CaterpillarLeg,
    desiredForward: Vec2,
    activity: number,
    tractionTargets: Vec2[]
  ) {
    const frame = this.legFrame(leg);
    const toHand = subtract(leg.anchor, frame.root);
    const handDistance = magnitude(toHand);
    if (handDistance < 0.001) return;

    const totalReach = this.totalLegReach();
    const pullTarget = totalReach * (0.44 + Math.abs(leg.postureBias) * 0.02);
    const contractionAmount = smoothstep(leg.contraction);
    const desiredDistance = lerp(
      Math.max(pullTarget, leg.plantDistance),
      pullTarget,
      contractionAmount
    );
    const stretch = Math.max(0, handDistance - desiredDistance);
    const pullDirection = scale(toHand, 1 / handDistance);
    const forwardAlignment = dot(pullDirection, desiredForward);

    // A hand behind the body may support it but cannot steer the cruise drive.
    if (forwardAlignment <= 0.02 || stretch <= 0.02) return;
    const bodyProgress = leg.nodeIndex / Math.max(1, this.nodes.length - 1);
    // Front hands do most of the steering work. Middle hands transmit that
    // turn, while rear hands mainly keep contact and are pulled into line last.
    const headLedDrive = lerp(1.55, 0.58, bodyProgress);
    const pullMagnitude =
      clamp(stretch * (0.28 + leg.load * 0.09), 0, 5.2) *
      leg.grip *
      activity *
      headLedDrive *
      BODY_DRIVE_SCALE;
    const reaction = scale(pullDirection, pullMagnitude);
    // Spread contact force through the neighbouring torso discs instead of
    // kicking one node and asking the constraint solver to snap the kink away.
    const recipients =
      leg.nodeIndex === 1
        ? [
            { index: 0, weight: 0.62 },
            { index: 1, weight: 0.32 },
            { index: 2, weight: 0.06 },
          ]
        : leg.nodeIndex === this.nodes.length - 1
          ? [
              { index: leg.nodeIndex - 1, weight: 0.46 },
              { index: leg.nodeIndex, weight: 0.54 },
            ]
          : [
              { index: leg.nodeIndex - 1, weight: 0.38 },
              { index: leg.nodeIndex, weight: 0.48 },
              { index: leg.nodeIndex + 1, weight: 0.14 },
            ];
    for (const recipient of recipients) {
      const target = tractionTargets[recipient.index];
      if (!target) continue;
      const distributed = scale(reaction, recipient.weight);
      tractionTargets[recipient.index] = add(target, distributed);
    }
  }

  private integrateTraction(
    targets: Vec2[],
    deltaSeconds: number,
    cruiseSpeed = 0,
    headForward: Vec2 = this.desiredForward()
  ) {
    const supportingHands = this.legs.filter(
      (leg) => leg.mode === "stance" && leg.contact
    ).length;
    const hasSupport = supportingHands >= Math.max(1, this.legs.length / 2);
    // Slow only in the emergency band near maximum reach. This continuous
    // limiter replaces the old positional snap-back, so contact cannot produce
    // a fast-forward/rewind cadence even during a tight turn.
    const commandedSpeed = hasSupport
      ? cruiseSpeed * this.stanceReachDriveScale()
      : 0;

    for (let index = 0; index < this.nodes.length; index += 1) {
      const routeDirection = this.routeDirectionAt(index, headForward);
      const contactDirection = normalize(targets[index], routeDirection);
      const targetDirection = normalize(
        lerpVec(routeDirection, contactDirection, 0.28),
        routeDirection
      );

      if (commandedSpeed > 0.5) {
        // Contact chooses the route, but never the magnitude. Normalising each
        // node to one shared cruise speed removes the reach/pull gait pulse.
        const currentDirection = normalize(
          this.tractionVelocity[index],
          targetDirection
        );
        const steeredDirection = normalize(
          lerpVec(
            currentDirection,
            targetDirection,
            exponentialApproach(7, deltaSeconds)
          ),
          targetDirection
        );
        this.tractionVelocity[index] = scale(
          steeredDirection,
          commandedSpeed
        );
      } else {
        this.tractionVelocity[index] = lerpVec(
          this.tractionVelocity[index],
          { x: 0, y: 0 },
          exponentialApproach(8, deltaSeconds)
        );
        if (magnitude(this.tractionVelocity[index]) < 0.35) {
          this.tractionVelocity[index] = { x: 0, y: 0 };
        }
      }

      const displacement = scale(this.tractionVelocity[index], deltaSeconds);
      const node = this.nodes[index];
      node.position = add(node.position, displacement);
      // Move the Verlet history by the same amount: this is a continuous
      // contact-derived drive, not a new ballistic impulse every gait phase.
      node.previous = add(node.previous, displacement);
    }
  }

  private stanceReachDriveScale() {
    const reach = Math.max(0.001, this.totalLegReach());
    let largestReachRatio = 0;
    for (const leg of this.legs) {
      if (leg.mode !== "stance" || !leg.contact) continue;
      const frame = this.legFrame(leg);
      largestReachRatio = Math.max(
        largestReachRatio,
        magnitude(subtract(leg.anchor, frame.root)) / reach
      );
    }
    if (largestReachRatio <= 0.78) return 1;
    // Full drive below 78% reach, continuously tapering to zero at 90%.
    // Normally the next group lands before this limiter becomes visible.
    return 1 - smoothstep(clamp((largestReachRatio - 0.78) / 0.12));
  }

  private integrateJoint(
    joint: LegJoint,
    deltaSeconds: number,
    leg: CaterpillarLeg
  ) {
    const contactGain = leg.mode === "stance" ? 0.82 + leg.load * 0.46 : 1;
    const error = wrapAngle(joint.targetAngle - joint.angle);
    const acceleration =
      joint.stiffness * contactGain * (1 + leg.reflex * 0.3) * error -
      joint.damping * (1 + leg.load * 0.2) * joint.angularVelocity;
    joint.angularVelocity += acceleration * deltaSeconds;
    joint.angularVelocity = clamp(joint.angularVelocity, -28, 28);
    joint.angle += joint.angularVelocity * deltaSeconds;
    if (joint.angle < joint.minimum || joint.angle > joint.maximum) {
      joint.angle = clamp(joint.angle, joint.minimum, joint.maximum);
      joint.angularVelocity *= -0.12;
    }
  }

  private solveJointTargets(
    leg: CaterpillarLeg,
    target: Vec2,
    frame: LegFrame
  ): [number, number, number] {
    const targetOffset = subtract(target, frame.root);
    const localTarget = {
      x: dot(targetOffset, frame.tangent),
      y: dot(targetOffset, frame.outward),
    };
    const angles: [number, number, number] = [
      leg.joints[0].targetAngle,
      leg.joints[1].targetAngle,
      leg.joints[2].targetAngle,
    ];
    const lengths = this.legLengths();

    for (let pass = 0; pass < 5; pass += 1) {
      for (let jointIndex = 2; jointIndex >= 0; jointIndex -= 1) {
        const points = this.localLegPoints(angles, lengths);
        const jointPoint = points[jointIndex];
        const endVector = subtract(points[3], jointPoint);
        const targetVector = subtract(localTarget, jointPoint);
        if (magnitude(endVector) < 0.001 || magnitude(targetVector) < 0.001) continue;
        const turn = Math.atan2(
          cross(endVector, targetVector),
          dot(endVector, targetVector)
        );
        angles[jointIndex] = clamp(
          angles[jointIndex] - clamp(turn, -0.44, 0.44),
          leg.joints[jointIndex].minimum,
          leg.joints[jointIndex].maximum
        );
      }
    }
    return angles;
  }

  private localLegPoints(
    angles: readonly [number, number, number],
    lengths: readonly [number, number, number]
  ): [Vec2, Vec2, Vec2, Vec2] {
    const points: [Vec2, Vec2, Vec2, Vec2] = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ];
    let accumulatedAngle = 0;
    for (let index = 0; index < 3; index += 1) {
      accumulatedAngle += angles[index];
      points[index + 1] = add(points[index], {
        x: Math.sin(accumulatedAngle) * lengths[index],
        y: Math.cos(accumulatedAngle) * lengths[index],
      });
    }
    return points;
  }

  private refreshLegGeometry(leg: CaterpillarLeg) {
    const frame = this.legFrame(leg);
    const lengths = this.legLengths();
    const localPoints = this.localLegPoints(
      [leg.joints[0].angle, leg.joints[1].angle, leg.joints[2].angle],
      lengths
    );
    let points = localPoints.map((point) =>
      add(
        frame.root,
        add(scale(frame.tangent, point.x), scale(frame.outward, point.y))
      )
    ) as [Vec2, Vec2, Vec2, Vec2];

    if (leg.mode === "stance" && leg.contact) {
      points = this.projectPinnedHand(points, frame.root, leg.anchor, lengths);
      const anchorDistance = magnitude(subtract(leg.anchor, frame.root));
      if (anchorDistance < lengths.reduce((sum, length) => sum + length, 0) * 0.998) {
        // Contact invariant: while anatomically reachable, a stance hand is the
        // exact world-space anchor and never inherits torso translation.
        points[3] = { ...leg.anchor };
      }
    }
    leg.points = points;
    leg.foot = { ...points[3] };
  }

  private projectPinnedHand(
    initial: [Vec2, Vec2, Vec2, Vec2],
    root: Vec2,
    anchor: Vec2,
    lengths: readonly [number, number, number]
  ): [Vec2, Vec2, Vec2, Vec2] {
    const points = initial.map((point) => ({ ...point })) as [
      Vec2,
      Vec2,
      Vec2,
      Vec2,
    ];
    const totalReach = lengths[0] + lengths[1] + lengths[2];
    const rootToAnchor = subtract(anchor, root);
    const anchorDistance = magnitude(rootToAnchor);

    if (anchorDistance >= totalReach * 0.998) {
      const direction = normalize(rootToAnchor, { x: 0, y: 1 });
      points[0] = { ...root };
      for (let index = 0; index < 3; index += 1) {
        // Safety fallback only. The torso contact projection normally keeps
        // this branch unreachable; if constraints conflict, retain anatomical
        // link lengths until releaseOverloadedContacts lifts the overloaded hand.
        points[index + 1] = add(
          points[index],
          scale(direction, lengths[index])
        );
      }
      return points;
    }

    // FABRIK projection keeps all three links at constant length while the hand
    // remains fixed. The motor pose supplies the bend preference.
    for (let pass = 0; pass < 7; pass += 1) {
      points[3] = { ...anchor };
      for (let index = 2; index >= 0; index -= 1) {
        const direction = normalize(subtract(points[index], points[index + 1]), {
          x: 0,
          y: -1,
        });
        points[index] = add(points[index + 1], scale(direction, lengths[index]));
      }
      points[0] = { ...root };
      for (let index = 0; index < 3; index += 1) {
        const direction = normalize(subtract(points[index + 1], points[index]), {
          x: 0,
          y: 1,
        });
        points[index + 1] = add(points[index], scale(direction, lengths[index]));
      }
    }
    return points;
  }

  private legFrame(leg: CaterpillarLeg): LegFrame {
    const tangent = this.tangentAt(leg.nodeIndex);
    const outward = scale(perpendicular(tangent), leg.side);
    const root = add(
      this.nodes[leg.nodeIndex].position,
      scale(outward, this.radiusAt(leg.nodeIndex) * 0.62)
    );
    return { root, tangent, outward };
  }

  private legLengths(): [number, number, number] {
    const growthScale = 0.26 + clamp(this.growth) * 0.74;
    return LEG_LINK_LENGTHS.map((length) => length * growthScale) as [
      number,
      number,
      number,
    ];
  }

  private totalLegReach() {
    return this.legLengths().reduce((sum, length) => sum + length, 0);
  }

  private neutralPose(postureBias: number): [number, number, number] {
    return [postureBias * 0.12, 0.52 - Math.abs(postureBias) * 0.06, -0.42];
  }

  private desiredForward(): Vec2 {
    return {
      x: Math.cos(this.headingAngle),
      y: Math.sin(this.headingAngle),
    };
  }

  private wallAwareDirection(direction: Vec2, bounds: Rect): Vec2 {
    const padding = this.baseRadius + 7;
    const margin = 72;
    const edge = padding + 5;
    const reflected = { ...direction };
    if (this.head.x <= bounds.x + edge && reflected.x < 0) {
      reflected.x = Math.abs(reflected.x);
    }
    if (
      this.head.x >= bounds.x + bounds.width - edge &&
      reflected.x > 0
    ) {
      reflected.x = -Math.abs(reflected.x);
    }
    if (this.head.y <= bounds.y + edge && reflected.y < 0) {
      reflected.y = Math.abs(reflected.y);
    }
    if (
      this.head.y >= bounds.y + bounds.height - edge &&
      reflected.y > 0
    ) {
      reflected.y = -Math.abs(reflected.y);
    }
    const reflectedDirection = normalize(reflected, scale(direction, -1));
    const lookAhead = add(this.head, scale(reflectedDirection, 54));
    const left = clamp(
      (bounds.x + padding + margin - lookAhead.x) / margin
    );
    const right = clamp(
      (lookAhead.x - (bounds.x + bounds.width - padding - margin)) / margin
    );
    const top = clamp(
      (bounds.y + padding + margin - lookAhead.y) / margin
    );
    const bottom = clamp(
      (lookAhead.y - (bounds.y + bounds.height - padding - margin)) / margin
    );
    const inward = {
      x: left * left - right * right,
      y: top * top - bottom * bottom,
    };
    const pressure = clamp(magnitude(inward));
    if (pressure < 0.001) return reflectedDirection;

    const inwardDirection = normalize(inward, scale(reflectedDirection, -1));
    const pointingOutward = clamp(-dot(reflectedDirection, inwardDirection));
    const avoidanceStrength = pressure * (0.85 + pointingOutward * 1.25);
    return normalize(
      add(reflectedDirection, scale(inwardDirection, avoidanceStrength)),
      inwardDirection
    );
  }

  private stepDirectionForLeg(
    leg: CaterpillarLeg,
    headForward: Vec2
  ): Vec2 {
    return this.routeDirectionAt(leg.nodeIndex, headForward);
  }

  private routeDirectionAt(nodeIndex: number, headForward: Vec2): Vec2 {
    const localTangent = this.tangentAt(nodeIndex);
    const bodyProgress = nodeIndex / Math.max(1, this.nodes.length - 1);
    // Steering is phase-delayed across all four torso discs. Each successive
    // pair inherits less of the head's new bearing and more of its local curve.
    const headInfluence =
      bodyProgress <= 0.26
        ? 1
        : bodyProgress <= 0.51
          ? 0.42
          : bodyProgress <= 0.76
            ? 0.16
            : 0.05;
    return normalize(
      add(
        scale(localTangent, 1 - headInfluence),
        scale(headForward, headInfluence)
      ),
      localTangent
    );
  }

  private constrainLegTargetToWorkspace(
    leg: CaterpillarLeg,
    target: Vec2,
    bounds: Rect
  ): Vec2 {
    const frame = this.legFrame(leg);
    const reach = this.totalLegReach();
    const offset = subtract(target, frame.root);
    let forward = clamp(dot(offset, frame.tangent), -reach * 0.12, reach * 0.78);
    let outward = clamp(dot(offset, frame.outward), reach * 0.28, reach * 0.62);
    const maximumRadius = reach * 0.88;
    const localRadius = Math.hypot(forward, outward);
    if (localRadius > maximumRadius) {
      const radiusScale = maximumRadius / localRadius;
      forward *= radiusScale;
      outward *= radiusScale;
    }
    return this.clampHandTarget(
      add(
        add(frame.root, scale(frame.tangent, forward)),
        scale(frame.outward, outward)
      ),
      bounds
    );
  }

  private legAnchorOutsideWorkspace(leg: CaterpillarLeg) {
    const frame = this.legFrame(leg);
    const reach = this.totalLegReach();
    const offset = subtract(leg.anchor, frame.root);
    const forward = dot(offset, frame.tangent);
    const outward = dot(offset, frame.outward);
    return (
      magnitude(offset) > reach * 0.78 ||
      forward < -reach * 0.22 ||
      forward > reach * 0.72 ||
      outward < reach * 0.08 ||
      outward > reach * 0.68
    );
  }

  private beginSwing(
    leg: CaterpillarLeg,
    desiredForward: Vec2,
    control: BodyControl,
    bounds: Rect
  ) {
    // The pinned FABRIK pose is the pose the user sees. Copy it back into the
    // rotational state before releasing, so liftoff starts continuously.
    this.refreshLegGeometry(leg);
    this.syncJointStateFromVisiblePose(leg);
    const frame = this.legFrame(leg);
    const totalReach = this.totalLegReach();
    const speedLead = clamp(control.speed / 70);
    // Small seeded variations keep the gait alive without changing its support
    // invariant or introducing frame-to-frame noise.
    const headingJitter = this.gaitRandom.between(-0.075, 0.075);
    const jitterCosine = Math.cos(headingJitter);
    const jitterSine = Math.sin(headingJitter);
    const reachDirection = {
      x: desiredForward.x * jitterCosine - desiredForward.y * jitterSine,
      y: desiredForward.x * jitterSine + desiredForward.y * jitterCosine,
    };
    const lateral =
      totalReach * (0.34 + this.gaitRandom.between(-0.025, 0.025));
    const lead =
      totalReach *
      (0.74 + speedLead * 0.04 + this.gaitRandom.between(-0.035, 0.035)) *
      this.strideScale;
    const target = add(
      add(frame.root, scale(frame.outward, lateral)),
      scale(reachDirection, lead)
    );

    leg.mode = "swing";
    leg.modeAge = 0;
    leg.planted = false;
    leg.contact = false;
    leg.grip = Math.min(leg.grip, 0.3);
    leg.load = 0;
    leg.contraction = 0;
    leg.contractionVelocity = 0;
    leg.elevationTarget = clamp(
      this.liftScale * this.gaitRandom.between(0.88, 1.12),
      0.68,
      1.12
    );
    leg.swingQueued = false;
    leg.swingDelay = 0;
    leg.motionScale = this.gaitRandom.between(0.86, 1.14);
    leg.refractory = 0.1;
    leg.stepDirection = { ...desiredForward };
    leg.landingTarget = this.constrainLegTargetToWorkspace(leg, target, bounds);
  }

  private plantLeg(leg: CaterpillarLeg) {
    // Contact occurs at the hand's actual kinematic position, never at a timer's
    // ideal target. Joint lengths and limits still bound its anatomical range.
    leg.anchor = { ...leg.foot };
    leg.landingTarget = { ...leg.anchor };
    leg.mode = "stance";
    leg.modeAge = 0;
    leg.stanceAge = 0;
    leg.planted = true;
    leg.contact = true;
    leg.grip = 0.72;
    leg.load = 0.08;
    leg.contraction = 0;
    leg.contractionVelocity = 0;
    leg.elevationTarget = 0;
    leg.swingQueued = false;
    leg.swingDelay = 0;
    leg.touchdownSignal = 1;
    leg.refractory = 0.12;
    leg.plantDistance = magnitude(
      subtract(leg.anchor, this.legFrame(leg).root)
    );
    // Touchdown compresses the local body disc. The coupled tissue solver
    // carries this impulse into neighbouring discs instead of shaking the
    // complete creature in unison.
    this.tissueVelocity[leg.nodeIndex] = clamp(
      this.tissueVelocity[leg.nodeIndex] + 1.9,
      -5,
      5
    );
    this.refreshLegGeometry(leg);
  }

  private syncJointStateFromVisiblePose(leg: CaterpillarLeg) {
    const frame = this.legFrame(leg);
    const cumulative: [number, number, number] = [0, 0, 0];
    for (let index = 0; index < 3; index += 1) {
      const segment = subtract(leg.points[index + 1], leg.points[index]);
      cumulative[index] = Math.atan2(
        dot(segment, frame.tangent),
        dot(segment, frame.outward)
      );
    }
    const relative: [number, number, number] = [
      cumulative[0],
      wrapAngle(cumulative[1] - cumulative[0]),
      wrapAngle(cumulative[2] - cumulative[1]),
    ];
    for (let index = 0; index < 3; index += 1) {
      const joint = leg.joints[index];
      const angle = clamp(relative[index], joint.minimum, joint.maximum);
      joint.angle = angle;
      joint.targetAngle = angle;
      joint.angularVelocity = 0;
    }
  }

  private activateLegs() {
    this.legsActivated = true;
    this.activeStepGroup = this.gaitRandom.next() < 0.5 ? 0 : 1;
    this.stepGroupAge = 0;
    const headForward = this.desiredForward();
    for (const leg of this.legs) {
      leg.mode = "stance";
      leg.contact = true;
      leg.planted = true;
      leg.anchor = { ...leg.foot };
      leg.landingTarget = { ...leg.foot };
      leg.plantDistance = magnitude(
        subtract(leg.anchor, this.legFrame(leg).root)
      );
      leg.contraction = 0;
      leg.contractionVelocity = 0;
      leg.swingQueued = false;
      leg.swingDelay = 0;
      leg.stanceAge = 0.08 + Math.abs(leg.postureBias) * 0.12;
      leg.stepDirection = this.stepDirectionForLeg(leg, headForward);
    }

    this.beginStepGroup(this.activeStepGroup, headForward);
  }

  private advanceAlternatingGait(
    control: BodyControl,
    activity: number,
    headForward: Vec2
  ) {
    if (activity <= 0.14 || control.speed <= 0.8) return;
    const activeLegs = this.legs.filter(
      (leg) => leg.gaitGroup === this.activeStepGroup
    );
    const expectedGroupSize = this.legs.length / 2;
    if (
      activeLegs.length !== expectedGroupSize ||
      activeLegs.some((leg) => leg.mode !== "stance" || leg.swingQueued)
    ) {
      return;
    }
    if (!this.activeGroupHasLanded) {
      this.activeGroupHasLanded = true;
      this.stepGroupAge = 0;
      return;
    }

    const totalReach = this.totalLegReach();
    const completed = activeLegs.every((leg) => {
      const distanceToHand = magnitude(
        subtract(leg.anchor, this.legFrame(leg).root)
      );
      const pullTarget =
        totalReach * (0.44 + Math.abs(leg.postureBias) * 0.02);
      return leg.contraction > 0.76 && distanceToHand <= pullTarget + 3.5;
    });

    // The deadline is only a jam escape; normal switching is pull-completion.
    if (!completed && this.stepGroupAge < 0.28) return;
    this.activeStepGroup = this.activeStepGroup === 0 ? 1 : 0;
    this.stepGroupAge = 0;
    this.beginStepGroup(this.activeStepGroup, headForward);
  }

  private beginStepGroup(group: 0 | 1, headForward: Vec2) {
    // The head owns the route. Each leg freezes a different delayed sample of
    // that route so the turn travels from head to tail instead of sliding the
    // entire creature sideways at once.
    this.travelDirection = { ...headForward };
    this.activeGroupHasLanded = false;
    this.stepGroupAge = 0;
    for (const leg of this.legs) {
      if (leg.gaitGroup === group) {
        leg.stepDirection = this.stepDirectionForLeg(leg, headForward);
        leg.swingQueued = true;
        leg.swingDelay =
          this.stepStagger *
          clamp(leg.timingBias + this.gaitRandom.between(-0.12, 0.12));
      }
    }
  }

  private clampHandTarget(target: Vec2, bounds: Rect): Vec2 {
    const padding = 8;
    return {
      x: clamp(target.x, bounds.x + padding, bounds.x + bounds.width - padding),
      y: clamp(target.y, bounds.y + padding, bounds.y + bounds.height - padding),
    };
  }

  private asymmetricBreath(phase: number) {
    const wrapped = ((phase % 1) + 1) % 1;
    const inhaleEnd = 0.62;
    if (wrapped < inhaleEnd) {
      return lerp(-0.48, 1, smoothstep(wrapped / inhaleEnd));
    }
    return lerp(
      1,
      -0.48,
      smoothstep((wrapped - inhaleEnd) / (1 - inhaleEnd))
    );
  }

  private updateOrganicTissue(deltaSeconds: number, locomotionPaused: boolean) {
    const delta = Math.min(1 / 30, deltaSeconds);
    const effort = clamp(this.lastControl.speed / 130);
    // BugWorld deliberately advances locomotion several times per display
    // frame. These low per-step rates therefore read as a calm 0.4-0.65 Hz
    // breath in real time, becoming only slightly quicker while walking.
    const breathingRate = lerp(0.08, 0.13, effort);
    this.breathPhase = (this.breathPhase + delta * breathingRate) % 1;
    const maturity = smoothstep(clamp((this.growth - 0.35) / 0.65));
    const nextVelocity = [...this.tissueVelocity];
    const nextCompression = [...this.tissueCompression];

    for (let index = 0; index < this.nodes.length; index += 1) {
      // A tiny phase delay prevents mechanical simultaneous scaling without
      // turning respiration into a travelling sine-wave locomotion trick.
      const breath = this.asymmetricBreath(this.breathPhase - index * 0.018);
      let touchdown = 0;
      let supportLoad = 0;
      let influenceTotal = 0;
      for (const leg of this.legs) {
        const influence = Math.exp(-Math.abs(leg.nodeIndex - index) * 0.9);
        touchdown += leg.touchdownSignal * influence;
        if (leg.contact) supportLoad += leg.load * influence;
        influenceTotal += influence;
      }
      supportLoad /= Math.max(0.001, influenceTotal);

      const contactCompression = locomotionPaused
        ? 0
        : clamp(touchdown * 0.46, 0, 1.1);
      const loadCompression = clamp((supportLoad - 0.12) * 0.24, -0.08, 0.2);
      const target =
        maturity * (breath * 0.52 + contactCompression + loadCompression);
      const neighbours =
        (this.tissueCompression[index - 1] ?? this.tissueCompression[index]) +
        (this.tissueCompression[index + 1] ?? this.tissueCompression[index]);
      const coupling = neighbours * 0.5 - this.tissueCompression[index];
      // Intentionally under-damped: impact overshoots once, then the coupled
      // chain absorbs it. This is the springiness of flesh, not elastic legs.
      // Rear discs are progressively softer and less damped, so an impact
      // reaches the tail as a delayed spring response instead of scaling the
      // complete torso at once.
      const rearward = index / Math.max(1, this.nodes.length - 1);
      const localSpring = lerp(24, 16, rearward);
      const neighbourSpring = lerp(18, 14, rearward);
      const damping = lerp(7.2, 5.4, rearward);
      const acceleration =
        localSpring * (target - this.tissueCompression[index]) +
        neighbourSpring * coupling -
        damping * this.tissueVelocity[index];
      nextVelocity[index] = clamp(
        this.tissueVelocity[index] + acceleration * delta,
        -5,
        5
      );
      nextCompression[index] = clamp(
        this.tissueCompression[index] + nextVelocity[index] * delta,
        -1,
        1.25
      );
    }

    for (let index = 0; index < this.nodes.length; index += 1) {
      this.tissueVelocity[index] = nextVelocity[index];
      this.tissueCompression[index] = nextCompression[index];
    }
  }

  private segmentRestLength(index: number) {
    const growthLength = this.segmentLength * (0.24 + this.growth * 0.76);
    const compression =
      ((this.tissueCompression[index] ?? 0) +
        (this.tissueCompression[index + 1] ?? 0)) *
      0.5;
    return growthLength * clamp(1 - compression * 0.03, 0.965, 1.03);
  }

  private releaseOverloadedContacts(
    control: BodyControl,
    bounds: Rect,
    headForward: Vec2
  ) {
    if (control.speed <= 0.8) return;
    const reach = Math.max(0.001, this.totalLegReach());
    const minimumSupport = Math.ceil(this.legs.length / 2);
    let supportCount = this.legs.filter(
      (leg) => leg.mode === "stance" && leg.contact
    ).length;
    const hasQueuedGroup = this.legs.some((leg) => leg.swingQueued);
    const overloaded = this.legs
      .filter(
        (leg) =>
          leg.mode === "stance" &&
          leg.contact &&
          (!hasQueuedGroup || leg.swingQueued)
      )
      .map((leg) => ({
        leg,
        ratio:
          magnitude(subtract(leg.anchor, this.legFrame(leg).root)) / reach,
      }))
      .filter(({ ratio }) => ratio > 0.86)
      .sort((left, right) => right.ratio - left.ratio);

    for (const { leg } of overloaded) {
      if (supportCount <= minimumSupport) break;
      // Let the most overloaded hand go first, but retain at least one complete
      // four-hand support set. No body coordinate is rewound or teleported.
      this.beginSwing(
        leg,
        this.stepDirectionForLeg(leg, headForward),
        control,
        bounds
      );
      supportCount -= 1;
    }
  }

  private applyHeadTrailShape(deltaSeconds: number, bounds: Rect) {
    this.recordHeadTrail();
    if (this.nodes.length < 2) return;

    const forward = this.desiredForward();
    const curveAmount = clamp(this.curvatureScale * 0.58, 0.46, 0.72);
    let distanceFromHead = 0;
    for (let index = 1; index < this.nodes.length; index += 1) {
      distanceFromHead += this.segmentRestLength(index - 1);
      const progress = (index - 1) / Math.max(1, this.nodes.length - 2);
      const trailTarget = this.sampleHeadTrail(distanceFromHead);
      const straightTarget = add(
        this.head,
        scale(forward, -distanceFromHead)
      );
      // Blend against a straight chain to retain a shallow, readable curve even
      // during a very tight cursor turn.
      const target = lerpVec(straightTarget, trailTarget, curveAmount);
      const node = this.nodes[index];
      const correction = scale(
        subtract(target, node.position),
        exponentialApproach(lerp(10, 4.2, progress), deltaSeconds)
      );
      node.position = add(node.position, correction);
      node.previous = add(node.previous, correction);
    }
    this.resolveBodySelfCollisions();
    this.keepInside(bounds);
  }

  private recordHeadTrail() {
    const newest = this.headTrail[0];
    if (!newest || magnitude(subtract(this.head, newest)) > 0.15) {
      this.headTrail.unshift({ ...this.head });
    } else {
      this.headTrail[0] = { ...this.head };
    }

    const maximumTrailLength =
      this.segmentLength * Math.max(7, this.nodes.length + 3);
    let travelled = 0;
    let keepCount = this.headTrail.length;
    for (let index = 1; index < this.headTrail.length; index += 1) {
      travelled += magnitude(
        subtract(this.headTrail[index], this.headTrail[index - 1])
      );
      if (travelled > maximumTrailLength) {
        keepCount = index + 1;
        break;
      }
    }
    if (keepCount < this.headTrail.length) {
      this.headTrail.length = keepCount;
    }
  }

  private sampleHeadTrail(distanceAlongTrail: number): Vec2 {
    let travelled = 0;
    for (let index = 1; index < this.headTrail.length; index += 1) {
      const newer = this.headTrail[index - 1];
      const older = this.headTrail[index];
      const segmentDistance = magnitude(subtract(older, newer));
      if (segmentDistance < 0.001) continue;
      if (travelled + segmentDistance >= distanceAlongTrail) {
        return lerpVec(
          newer,
          older,
          (distanceAlongTrail - travelled) / segmentDistance
        );
      }
      travelled += segmentDistance;
    }
    return { ...(this.headTrail[this.headTrail.length - 1] ?? this.head) };
  }

  private resetHeadTrail() {
    this.headTrail.length = 0;
    const trailLength = this.segmentLength * Math.max(7, this.nodes.length + 3);
    for (let distance = 0; distance <= trailLength; distance += 3) {
      this.headTrail.push({
        x: this.head.x - distance,
        y: this.head.y,
      });
    }
  }

  private solveBodyShape(bounds: Rect, passes: number) {
    for (let pass = 0; pass < passes; pass += 1) {
      for (let index = 0; index < this.nodes.length - 1; index += 1) {
        const first = this.nodes[index];
        const second = this.nodes[index + 1];
        const delta = subtract(second.position, first.position);
        const distance = Math.max(0.001, magnitude(delta));
        const desiredLength = this.segmentRestLength(index);
        const correction = scale(delta, (distance - desiredLength) / distance);
        const headBias = index === 0 ? 0.38 : 0.5;
        first.position = add(first.position, scale(correction, headBias));
        second.position = add(second.position, scale(correction, -(1 - headBias)));
      }

      for (let index = 1; index < this.nodes.length - 1; index += 1) {
        const midpoint = scale(
          add(this.nodes[index - 1].position, this.nodes[index + 1].position),
          0.5
        );
        this.nodes[index].position = lerpVec(
          this.nodes[index].position,
          midpoint,
          0.015
        );
      }
      this.limitBodyBend();
      this.resolveBodySelfCollisions();
      this.keepInside(bounds);
    }
  }

  private limitBodyBend() {
    const maximumBend = 1.16;
    for (let index = 1; index < this.nodes.length - 1; index += 1) {
      const previous = this.nodes[index - 1].position;
      const current = this.nodes[index].position;
      const nextNode = this.nodes[index + 1];
      const towardHead = normalize(subtract(previous, current), this.desiredForward());
      const straightTail = scale(towardHead, -1);
      const currentTail = subtract(nextNode.position, current);
      const tailLength = Math.max(0.001, magnitude(currentTail));
      const straightAngle = Math.atan2(straightTail.y, straightTail.x);
      const tailAngle = Math.atan2(currentTail.y, currentTail.x);
      const bend = wrapAngle(tailAngle - straightAngle);
      if (Math.abs(bend) <= maximumBend) continue;

      const allowedAngle = straightAngle + clamp(bend, -maximumBend, maximumBend);
      const target = add(current, {
        x: Math.cos(allowedAngle) * tailLength,
        y: Math.sin(allowedAngle) * tailLength,
      });
      const correctionStrength =
        Math.abs(bend) > 1.42
          ? 0.7
          : lerp(0.16, 0.38, clamp((Math.abs(bend) - maximumBend) / 0.48));
      const corrected = lerpVec(
        nextNode.position,
        target,
        correctionStrength
      );
      const correction = subtract(corrected, nextNode.position);
      nextNode.position = corrected;
      nextNode.previous = add(nextNode.previous, correction);
    }
  }

  private resolveBodySelfCollisions() {
    for (let firstIndex = 0; firstIndex < this.nodes.length; firstIndex += 1) {
      for (
        let secondIndex = firstIndex + 2;
        secondIndex < this.nodes.length;
        secondIndex += 1
      ) {
        const first = this.nodes[firstIndex];
        const second = this.nodes[secondIndex];
        const separation = subtract(second.position, first.position);
        const separationDistance = magnitude(separation);
        const firstRadius =
          this.radiusAt(firstIndex) * (firstIndex === 0 ? 1.18 : 1);
        const secondRadius = this.radiusAt(secondIndex);
        const minimumDistance = firstRadius + secondRadius + 4;
        if (separationDistance >= minimumDistance) continue;

        const fallback = scale(
          perpendicular(this.desiredForward()),
          (firstIndex + secondIndex) % 2 === 0 ? 1 : -1
        );
        const direction = normalize(separation, fallback);
        const penetration = minimumDistance - separationDistance;
        const correctionStrength = penetration > 6 ? 0.72 : 0.34;
        const firstShare = firstIndex === 0 ? 0.22 : 0.5;
        const firstCorrection = scale(
          direction,
          -penetration * firstShare * correctionStrength
        );
        const secondCorrection = scale(
          direction,
          penetration * (1 - firstShare) * correctionStrength
        );
        first.position = add(first.position, firstCorrection);
        first.previous = add(first.previous, firstCorrection);
        second.position = add(second.position, secondCorrection);
        second.previous = add(second.previous, secondCorrection);
      }
    }
  }

  private keepInside(bounds: Rect) {
    const padding = this.baseRadius + 7;
    for (const node of this.nodes) {
      const old = { ...node.position };
      node.position.x = clamp(
        node.position.x,
        bounds.x + padding,
        bounds.x + bounds.width - padding
      );
      node.position.y = clamp(
        node.position.y,
        bounds.y + padding,
        bounds.y + bounds.height - padding
      );
      if (old.x !== node.position.x) node.previous.x = node.position.x;
      if (old.y !== node.position.y) node.previous.y = node.position.y;
    }
  }
}
