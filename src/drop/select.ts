import { BOARD_GEOMETRY, type BoardGeometry } from "./geometry.ts";
import { simulateDrop, type DropResult } from "./simulate.ts";

export interface PathSelectionResult {
  readonly drop: DropResult | null;
  readonly attemptCount: number;
  readonly releaseXCoordinates: readonly number[];
}

function validateTargetLane(targetLane: number, geometry: BoardGeometry): void {
  if (
    !Number.isInteger(targetLane)
    || targetLane < 0
    || targetLane >= geometry.laneCount
  ) {
    throw new RangeError(`Target lane ${targetLane} is outside the board.`);
  }

  if (geometry.closedLaneIndices.includes(targetLane)) {
    throw new RangeError(`Target lane ${targetLane} is closed.`);
  }
}

function freezeSelection(
  drop: DropResult | null,
  releaseXCoordinates: number[],
): PathSelectionResult {
  const frozenCoordinates = Object.freeze(releaseXCoordinates);
  return Object.freeze({
    drop,
    attemptCount: frozenCoordinates.length,
    releaseXCoordinates: frozenCoordinates,
  });
}

export function selectPath(
  targetLane: number,
  candidateSeeds: readonly number[],
  geometry: BoardGeometry = BOARD_GEOMETRY,
): PathSelectionResult {
  validateTargetLane(targetLane, geometry);

  if (candidateSeeds.some((seed) => !Number.isSafeInteger(seed))) {
    throw new RangeError("Every candidate seed must be a safe integer.");
  }

  const releaseXCoordinates: number[] = [];

  for (const candidateSeed of candidateSeeds) {
    const drop = simulateDrop(candidateSeed, geometry);
    const releasePoint = drop.path[0];
    if (releasePoint === undefined) {
      throw new Error("The simulation returned no release point.");
    }

    releaseXCoordinates.push(releasePoint.x);
    if (drop.restingLane === targetLane) {
      return freezeSelection(drop, releaseXCoordinates);
    }
  }

  return freezeSelection(null, releaseXCoordinates);
}
