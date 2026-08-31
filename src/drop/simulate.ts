import {
  BOARD_GEOMETRY,
  type BoardGeometry,
  type Bounds2D,
  type PegGeometry,
  type Point2D,
} from "./geometry.ts";

export interface DropSample {
  readonly time: number;
  readonly x: number;
  readonly y: number;
}

interface IndexedCollision {
  readonly time: number;
  readonly point: Point2D;
  readonly geometryIndex: number;
}

export type DropCollision =
  | (IndexedCollision & { readonly kind: "peg" })
  | (IndexedCollision & { readonly kind: "wall" })
  | (IndexedCollision & { readonly kind: "cap" })
  | {
    readonly kind: "floor";
    readonly time: number;
    readonly point: Point2D;
  };

export type DropStatus = "rested" | "timed_out" | "escaped";
export type RestingSurface = "floor" | "cap";

export interface DropResult {
  readonly seed: number;
  readonly status: DropStatus;
  readonly path: readonly DropSample[];
  readonly collisions: readonly DropCollision[];
  readonly restingSurface: RestingSurface | null;
  readonly restingLane: number | null;
}

interface MutablePoint {
  x: number;
  y: number;
}

interface Contact {
  readonly point: Point2D;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function freezePoint(point: Point2D): Point2D {
  return Object.freeze({ x: point.x, y: point.y });
}

function contactTolerance(geometry: BoardGeometry): number {
  return geometry.ballRadius * 1e-7;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function applyBounce(
  velocity: MutablePoint,
  normal: Point2D,
  geometry: BoardGeometry,
): void {
  const normalVelocity = velocity.x * normal.x + velocity.y * normal.y;
  if (normalVelocity >= 0) return;

  const tangentX = velocity.x - normalVelocity * normal.x;
  const tangentY = velocity.y - normalVelocity * normal.y;
  velocity.x = tangentX * geometry.physics.tangentialDamping
    - normalVelocity * geometry.physics.restitution * normal.x;
  velocity.y = tangentY * geometry.physics.tangentialDamping
    - normalVelocity * geometry.physics.restitution * normal.y;
}

function resolvePeg(
  position: MutablePoint,
  velocity: MutablePoint,
  peg: PegGeometry,
  geometry: BoardGeometry,
  horizontalJitter = 0,
): Contact | null {
  const contactDistance = geometry.ballRadius + geometry.pegRadius;
  const offsetX = position.x - peg.x;
  const offsetY = position.y - peg.y;
  const distanceSquared = offsetX * offsetX + offsetY * offsetY;
  if (distanceSquared >= contactDistance * contactDistance) return null;

  const distance = Math.sqrt(distanceSquared);
  let normalX: number;
  let normalY: number;

  if (distance > Number.EPSILON) {
    normalX = offsetX / distance;
    normalY = offsetY / distance;
  } else {
    const speed = Math.hypot(velocity.x, velocity.y);
    normalX = speed > Number.EPSILON ? -velocity.x / speed : 0;
    normalY = speed > Number.EPSILON ? -velocity.y / speed : 1;
  }

  position.x = peg.x + normalX * contactDistance;
  position.y = peg.y + normalY * contactDistance;
  velocity.x += horizontalJitter;
  const normal = { x: normalX, y: normalY };
  applyBounce(velocity, normal, geometry);

  return {
    point: {
      x: peg.x + normalX * geometry.pegRadius,
      y: peg.y + normalY * geometry.pegRadius,
    },
  };
}

function resolveBounds(
  position: MutablePoint,
  velocity: MutablePoint,
  bounds: Bounds2D,
  geometry: BoardGeometry,
): Contact | null {
  const nearestX = clamp(position.x, bounds.minX, bounds.maxX);
  const nearestY = clamp(position.y, bounds.minY, bounds.maxY);
  const offsetX = position.x - nearestX;
  const offsetY = position.y - nearestY;
  const distanceSquared = offsetX * offsetX + offsetY * offsetY;
  if (distanceSquared >= geometry.ballRadius * geometry.ballRadius) return null;

  const distance = Math.sqrt(distanceSquared);
  let normal: Point2D;
  let point: Point2D;
  let correction: number;

  if (distance > Number.EPSILON) {
    normal = { x: offsetX / distance, y: offsetY / distance };
    point = { x: nearestX, y: nearestY };
    correction = geometry.ballRadius - distance;
  } else {
    const faces = [
      {
        distance: position.x - bounds.minX,
        normal: { x: -1, y: 0 },
        point: { x: bounds.minX, y: clamp(position.y, bounds.minY, bounds.maxY) },
      },
      {
        distance: bounds.maxX - position.x,
        normal: { x: 1, y: 0 },
        point: { x: bounds.maxX, y: clamp(position.y, bounds.minY, bounds.maxY) },
      },
      {
        distance: position.y - bounds.minY,
        normal: { x: 0, y: -1 },
        point: { x: clamp(position.x, bounds.minX, bounds.maxX), y: bounds.minY },
      },
      {
        distance: bounds.maxY - position.y,
        normal: { x: 0, y: 1 },
        point: { x: clamp(position.x, bounds.minX, bounds.maxX), y: bounds.maxY },
      },
    ];
    const face = faces.reduce((closest, candidate) => (
      candidate.distance < closest.distance ? candidate : closest
    ));
    normal = face.normal;
    point = face.point;
    correction = geometry.ballRadius + Math.max(0, face.distance);
  }

  position.x += normal.x * correction;
  position.y += normal.y * correction;
  applyBounce(velocity, normal, geometry);
  return { point };
}

function resolveFloor(
  position: MutablePoint,
  velocity: MutablePoint,
  geometry: BoardGeometry,
): Contact | null {
  const boardMinimum = geometry.laneOriginX;
  const boardMaximum = geometry.laneOriginX + geometry.boardWidth;
  if (position.x < boardMinimum || position.x > boardMaximum) return null;
  if (position.y - geometry.ballRadius >= geometry.bucket.bottomY) return null;

  position.y = geometry.bucket.bottomY + geometry.ballRadius;
  const normal = { x: 0, y: 1 };
  applyBounce(velocity, normal, geometry);
  return {
    point: {
      x: position.x,
      y: geometry.bucket.bottomY,
    },
  };
}

function restingSurfaceForPosition(
  position: Point2D,
  geometry: BoardGeometry,
): RestingSurface | null {
  const tolerance = contactTolerance(geometry);
  const ballBottom = position.y - geometry.ballRadius;

  for (const cap of geometry.caps) {
    if (
      Math.abs(ballBottom - cap.bounds.maxY) <= tolerance
      && position.x >= cap.bounds.minX - tolerance
      && position.x <= cap.bounds.maxX + tolerance
    ) {
      return "cap";
    }
  }

  if (
    Math.abs(ballBottom - geometry.bucket.bottomY) <= tolerance
    && position.x >= geometry.laneOriginX - tolerance
    && position.x <= geometry.laneOriginX + geometry.boardWidth + tolerance
  ) {
    return "floor";
  }

  return null;
}

export function restingLaneForPosition(
  position: Point2D,
  geometry: BoardGeometry = BOARD_GEOMETRY,
): number | null {
  if (restingSurfaceForPosition(position, geometry) !== "floor") return null;

  const tolerance = contactTolerance(geometry);
  for (const lane of geometry.lanes) {
    if (geometry.closedLaneIndices.includes(lane.index)) continue;
    if (
      position.x - geometry.ballRadius >= lane.opening.minX - tolerance
      && position.x + geometry.ballRadius <= lane.opening.maxX + tolerance
    ) {
      return lane.index;
    }
  }

  return null;
}

export function simulateDrop(
  seed: number,
  geometry: BoardGeometry = BOARD_GEOMETRY,
): DropResult {
  if (!Number.isSafeInteger(seed)) throw new RangeError("Seed must be a safe integer.");

  const random = createSeededRandom(seed);
  const firstPegJitter = (random() * 2 - 1) * geometry.physics.firstPegJitterSpeed;
  const position: MutablePoint = {
    x: geometry.releasePoint.x,
    y: geometry.releasePoint.y,
  };
  const velocity: MutablePoint = { x: 0, y: 0 };
  const path: DropSample[] = [Object.freeze({ time: 0, x: position.x, y: position.y })];
  const collisions: DropCollision[] = [];
  const totalSteps = Math.ceil(
    geometry.physics.maximumDropSeconds / geometry.physics.fixedStepSeconds,
  );
  let quietSeconds = 0;
  let status: DropStatus = "timed_out";
  let restingSurface: RestingSurface | null = null;
  let firstPegJitterApplied = false;

  for (let step = 1; step <= totalSteps; step += 1) {
    const time = step * geometry.physics.fixedStepSeconds;
    velocity.y += geometry.physics.gravityY * geometry.physics.fixedStepSeconds;
    position.x += velocity.x * geometry.physics.fixedStepSeconds;
    position.y += velocity.y * geometry.physics.fixedStepSeconds;
    const collisionKeys = new Set<string>();

    const recordIndexedCollision = (
      kind: "peg" | "wall" | "cap",
      geometryIndex: number,
      point: Point2D,
    ): void => {
      const key = `${kind}:${geometryIndex}`;
      if (collisionKeys.has(key)) return;
      collisionKeys.add(key);
      collisions.push(Object.freeze({
        kind,
        time,
        geometryIndex,
        point: freezePoint(point),
      }));
    };

    for (let pass = 0; pass < 2; pass += 1) {
      for (let index = 0; index < geometry.pegs.length; index += 1) {
        const peg = geometry.pegs[index];
        if (peg === undefined) continue;
        const appliesFirstPegJitter = !firstPegJitterApplied && peg.row === 0;
        const contact = resolvePeg(
          position,
          velocity,
          peg,
          geometry,
          appliesFirstPegJitter ? firstPegJitter : 0,
        );
        if (contact !== null && appliesFirstPegJitter) firstPegJitterApplied = true;
        if (contact !== null) recordIndexedCollision("peg", index, contact.point);
      }

      for (let index = 0; index < geometry.bucketWalls.length; index += 1) {
        const wall = geometry.bucketWalls[index];
        if (wall === undefined) continue;
        const contact = resolveBounds(position, velocity, wall.bounds, geometry);
        if (contact !== null) recordIndexedCollision("wall", index, contact.point);
      }

      for (let index = 0; index < geometry.caps.length; index += 1) {
        const cap = geometry.caps[index];
        if (cap === undefined) continue;
        const contact = resolveBounds(position, velocity, cap.bounds, geometry);
        if (contact !== null) recordIndexedCollision("cap", index, contact.point);
      }

      const floorContact = resolveFloor(position, velocity, geometry);
      if (floorContact !== null && !collisionKeys.has("floor")) {
        collisionKeys.add("floor");
        collisions.push(Object.freeze({
          kind: "floor",
          time,
          point: freezePoint(floorContact.point),
        }));
      }
    }

    path.push(Object.freeze({ time, x: position.x, y: position.y }));
    const support = restingSurfaceForPosition(position, geometry);
    if (support !== null && Math.hypot(velocity.x, velocity.y) <= geometry.physics.restSpeed) {
      quietSeconds += geometry.physics.fixedStepSeconds;
      if (quietSeconds >= geometry.physics.restSeconds) {
        status = "rested";
        restingSurface = support;
        break;
      }
    } else {
      quietSeconds = 0;
    }

    if (position.y < geometry.bucket.bottomY - geometry.ballRadius) {
      status = "escaped";
      break;
    }
  }

  const finalPosition = path.at(-1);
  const restingLane = status === "rested" && finalPosition !== undefined
    ? restingLaneForPosition(finalPosition, geometry)
    : null;

  return Object.freeze({
    seed,
    status,
    path: Object.freeze(path),
    collisions: Object.freeze(collisions),
    restingSurface,
    restingLane,
  });
}
