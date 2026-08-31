export interface Point2D {
  readonly x: number;
  readonly y: number;
}

export interface Bounds2D {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface PegGeometry extends Point2D {
  readonly row: number;
  readonly column: number;
}

export interface LaneGeometry {
  readonly index: number;
  readonly centerX: number;
  readonly bounds: Bounds2D;
  readonly opening: Bounds2D;
}

export interface BucketWallGeometry {
  readonly boundaryIndex: number;
  readonly bounds: Bounds2D;
}

export interface CapGeometry {
  readonly laneIndex: number;
  readonly bounds: Bounds2D;
}

export interface BoardGeometry {
  readonly revision: string;
  readonly laneCount: number;
  readonly rowCount: number;
  readonly laneWidth: number;
  readonly laneOriginX: number;
  readonly boardWidth: number;
  readonly boardCenterX: number;
  readonly pegSpacing: Point2D;
  readonly pegRadius: number;
  readonly ballRadius: number;
  readonly latticeTopY: number;
  readonly releasePoint: Point2D;
  readonly bucket: {
    readonly topY: number;
    readonly bottomY: number;
    readonly wallThickness: number;
    readonly capThickness: number;
  };
  readonly physics: {
    readonly gravityY: number;
    readonly firstPegJitterSpeed: number;
    readonly restitution: number;
    readonly tangentialDamping: number;
    readonly fixedStepSeconds: number;
    readonly maximumDropSeconds: number;
    readonly restSpeed: number;
    readonly restSeconds: number;
  };
  readonly laneCenters: readonly number[];
  readonly lanes: readonly LaneGeometry[];
  readonly pegRows: readonly (readonly PegGeometry[])[];
  readonly pegs: readonly PegGeometry[];
  readonly bucketWalls: readonly BucketWallGeometry[];
  readonly closedLaneIndices: readonly number[];
  readonly caps: readonly CapGeometry[];
}

const measurements = Object.freeze({
  laneCount: 15,
  laneWidth: 1,
  pegVerticalSpacing: 0.82,
  pegRadius: 0.1,
  ballRadius: 0.18,
  bottomPegClearance: 0.82,
  releaseClearance: 0.9,
  firstPegJitterSpeed: 2,
  bucketTopY: 0,
  bucketBottomY: -1.7,
  bucketWallThickness: 0.12,
  capThickness: 0.14,
  gravityY: -9.81,
  restitution: 0.38,
  tangentialDamping: 0.995,
  fixedStepSeconds: 1 / 240,
  maximumDropSeconds: 12,
  restSpeed: 0.04,
  restSeconds: 0.35,
});

function freezeBounds(bounds: Bounds2D): Bounds2D {
  return Object.freeze(bounds);
}

function buildGeometry(laneCount: number): BoardGeometry {
  const rowCount = laneCount - 1;
  const laneWidth = measurements.laneWidth;
  const boardWidth = laneCount * laneWidth;
  const laneOriginX = -boardWidth / 2;
  const boardCenterX = laneOriginX + boardWidth / 2;
  const pegSpacing = Object.freeze({ x: laneWidth, y: measurements.pegVerticalSpacing });
  const latticeTopY = measurements.bucketTopY
    + measurements.bottomPegClearance
    + (rowCount - 1) * pegSpacing.y;

  const lanes = Object.freeze(Array.from({ length: laneCount }, (_, index): LaneGeometry => {
    const minX = laneOriginX + index * laneWidth;
    const maxX = minX + laneWidth;
    const centerX = (minX + maxX) / 2;
    const halfWall = measurements.bucketWallThickness / 2;

    return Object.freeze({
      index,
      centerX,
      bounds: freezeBounds({
        minX,
        maxX,
        minY: measurements.bucketBottomY,
        maxY: measurements.bucketTopY,
      }),
      opening: freezeBounds({
        minX: minX + halfWall,
        maxX: maxX - halfWall,
        minY: measurements.bucketBottomY,
        maxY: measurements.bucketTopY,
      }),
    });
  }));

  const pegRows = Object.freeze(Array.from({ length: rowCount }, (_, row) => Object.freeze(
    Array.from({ length: row + 1 }, (_, column): PegGeometry => Object.freeze({
      row,
      column,
      x: boardCenterX + (column - row / 2) * pegSpacing.x,
      y: latticeTopY - row * pegSpacing.y,
    })),
  )));

  const bucketWalls = Object.freeze(Array.from(
    { length: laneCount + 1 },
    (_, boundaryIndex): BucketWallGeometry => {
      const centerX = laneOriginX + boundaryIndex * laneWidth;
      const halfWall = measurements.bucketWallThickness / 2;
      return Object.freeze({
        boundaryIndex,
        bounds: freezeBounds({
          minX: centerX - halfWall,
          maxX: centerX + halfWall,
          minY: measurements.bucketBottomY,
          maxY: measurements.bucketTopY,
        }),
      });
    },
  ));

  return Object.freeze({
    revision: "plinko-geometry-v2",
    laneCount,
    rowCount,
    laneWidth,
    laneOriginX,
    boardWidth,
    boardCenterX,
    pegSpacing,
    pegRadius: measurements.pegRadius,
    ballRadius: measurements.ballRadius,
    latticeTopY,
    releasePoint: Object.freeze({
      x: boardCenterX,
      y: latticeTopY + measurements.releaseClearance,
    }),
    bucket: Object.freeze({
      topY: measurements.bucketTopY,
      bottomY: measurements.bucketBottomY,
      wallThickness: measurements.bucketWallThickness,
      capThickness: measurements.capThickness,
    }),
    physics: Object.freeze({
      gravityY: measurements.gravityY,
      firstPegJitterSpeed: measurements.firstPegJitterSpeed,
      restitution: measurements.restitution,
      tangentialDamping: measurements.tangentialDamping,
      fixedStepSeconds: measurements.fixedStepSeconds,
      maximumDropSeconds: measurements.maximumDropSeconds,
      restSpeed: measurements.restSpeed,
      restSeconds: measurements.restSeconds,
    }),
    laneCenters: Object.freeze(lanes.map((lane) => lane.centerX)),
    lanes,
    pegRows,
    pegs: Object.freeze(pegRows.flat()),
    bucketWalls,
    closedLaneIndices: Object.freeze([]),
    caps: Object.freeze([]),
  });
}

export function createBoardGeometry(laneCount: number): BoardGeometry {
  if (!Number.isInteger(laneCount)) {
    throw new RangeError("The lane count must be a whole number.");
  }
  if (laneCount < 2) {
    throw new RangeError("The board needs at least 2 lanes.");
  }
  if (laneCount > measurements.laneCount) {
    throw new RangeError(`The board supports at most ${measurements.laneCount} lanes.`);
  }
  return buildGeometry(laneCount);
}

export const BOARD_GEOMETRY: BoardGeometry = createBoardGeometry(measurements.laneCount);

export function withClosedLanes(
  closedLaneIndices: readonly number[],
  source: BoardGeometry = BOARD_GEOMETRY,
): BoardGeometry {
  const uniqueIndices = new Set(closedLaneIndices);
  if (uniqueIndices.size !== closedLaneIndices.length) {
    throw new RangeError("A lane can only be closed once.");
  }

  const sortedIndices = [...uniqueIndices].sort((left, right) => left - right);
  for (const laneIndex of sortedIndices) {
    if (!Number.isInteger(laneIndex) || laneIndex < 0 || laneIndex >= source.laneCount) {
      throw new RangeError(`Lane index ${laneIndex} is outside the board.`);
    }
  }

  if (
    sortedIndices.length === source.closedLaneIndices.length
    && sortedIndices.every((laneIndex, index) => laneIndex === source.closedLaneIndices[index])
  ) {
    return source;
  }

  const halfCap = source.bucket.capThickness / 2;
  const caps = Object.freeze(sortedIndices.map((laneIndex): CapGeometry => {
    const lane = source.lanes[laneIndex];
    if (lane === undefined) throw new RangeError(`Lane index ${laneIndex} is outside the board.`);

    return Object.freeze({
      laneIndex,
      bounds: freezeBounds({
        minX: lane.opening.minX,
        maxX: lane.opening.maxX,
        minY: source.bucket.topY - halfCap,
        maxY: source.bucket.topY + halfCap,
      }),
    });
  }));

  return Object.freeze({
    ...source,
    closedLaneIndices: Object.freeze(sortedIndices),
    caps,
  });
}
