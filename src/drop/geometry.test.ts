import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BOARD_GEOMETRY, createBoardGeometry, withClosedLanes } from "./geometry.ts";

const geometryNumberNames = [
  "ballRadius",
  "boardCenterX",
  "boardWidth",
  "bottomPegClearance",
  "bucketBottomY",
  "bucketTopY",
  "bucketWallThickness",
  "capMaxY",
  "capMinY",
  "capThickness",
  "capY",
  "fixedStepSeconds",
  "firstPegJitterSpeed",
  "gravityY",
  "laneCount",
  "laneOriginX",
  "laneWidth",
  "latticeTopY",
  "maximumDropSeconds",
  "pegHorizontalSpacing",
  "pegRadius",
  "pegSpacing",
  "pegVerticalSpacing",
  "releaseClearance",
  "restitution",
  "restSeconds",
  "restSpeed",
  "rowCount",
  "tangentialDamping",
  "wallThickness",
] as const;

const geometryNumberName = `(?:${geometryNumberNames.join("|")})`;
const numericLiteral = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?`;
const numericGeometryDeclarations = [
  new RegExp(
    String.raw`\b(?:const|let|var)\s+${geometryNumberName}\s*(?:\:\s*[^=;,\n]+)?=\s*${numericLiteral}`,
    "i",
  ),
  new RegExp(String.raw`\b${geometryNumberName}\s*:\s*${numericLiteral}`, "i"),
  new RegExp(String.raw`\b${geometryNumberName}\s*=\s*${numericLiteral}`, "i"),
];
const latticeField = new RegExp(
  String.raw`\b(?:${geometryNumberNames.join("|")}|releasePoint|bucketWalls)\b`,
);
const geometryImport = /from\s+["'][^"']*\/geometry(?:\.ts)?["']/;

interface SourceViolation {
  readonly path: string;
  readonly reason: string;
}

function declaresNumericGeometry(source: string): boolean {
  return numericGeometryDeclarations.some((declaration) => declaration.test(source));
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry): Promise<string[]> => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [path];
  }));
  return files.flat();
}

async function findGeometrySourceViolations(directory: string): Promise<SourceViolation[]> {
  const geometryModule = join(directory, "drop", "geometry.ts");
  const files = (await sourceFiles(directory)).filter((path) => path !== geometryModule);
  const violations: SourceViolation[] = [];

  for (const path of files) {
    const source = await readFile(path, "utf8");
    if (declaresNumericGeometry(source)) {
      violations.push({ path, reason: "declares a second geometry number" });
      continue;
    }
    if (latticeField.test(source) && !geometryImport.test(source)) {
      violations.push({ path, reason: "uses lattice fields without the shared geometry" });
    }
  }

  return violations;
}

describe("board geometry", () => {
  it("builds fourteen centered lanes when the list has fourteen restaurants", () => {
    const geometry = createBoardGeometry(14);

    expect(geometry.laneCount).toBe(14);
    expect(geometry.rowCount).toBe(13);
    expect(geometry.lanes).toHaveLength(14);
    expect(geometry.bucketWalls).toHaveLength(15);
    expect(geometry.pegs).toHaveLength(91);
    expect(geometry.boardCenterX).toBe(0);
    expect(geometry.releasePoint.x).toBe(0);
    expect((geometry.lanes[0]?.centerX ?? Infinity) + (geometry.lanes.at(-1)?.centerX ?? Infinity))
      .toBe(0);
  });

  it("keeps configured geometry within the supported lane range", () => {
    expect(() => createBoardGeometry(1)).toThrow("at least 2");
    expect(() => createBoardGeometry(16)).toThrow("at most 15");
    expect(() => createBoardGeometry(14.5)).toThrow("whole number");
  });

  it("derives all fifteen lane centers and both outer buckets from one origin", () => {
    const geometry = BOARD_GEOMETRY;
    const left = geometry.lanes[0];
    const right = geometry.lanes[geometry.laneCount - 1];

    expect(geometry.laneCenters).toHaveLength(15);
    expect(left?.centerX).toBe(geometry.laneOriginX + geometry.laneWidth / 2);
    expect(left?.bounds.minX).toBe(geometry.laneOriginX);
    expect(right?.centerX).toBe(
      geometry.laneOriginX + geometry.boardWidth - geometry.laneWidth / 2,
    );
    expect(right?.bounds.maxX).toBe(geometry.laneOriginX + geometry.boardWidth);

    for (let index = 1; index < geometry.lanes.length; index += 1) {
      expect(geometry.lanes[index]?.bounds.minX).toBe(geometry.lanes[index - 1]?.bounds.maxX);
    }
  });

  it("builds the triangular peg rows from the shared spacing", () => {
    const geometry = BOARD_GEOMETRY;
    const bottomRow = geometry.pegRows[geometry.rowCount - 1];

    expect(geometry.rowCount).toBe(geometry.laneCount - 1);
    expect(geometry.pegs).toHaveLength(
      geometry.rowCount * (geometry.rowCount + 1) / 2,
    );
    expect(geometry.pegRows.map((row) => row.length)).toEqual(
      Array.from({ length: geometry.rowCount }, (_, row) => row + 1),
    );

    for (const peg of geometry.pegs) {
      expect(peg.x).toBe(
        geometry.boardCenterX + (peg.column - peg.row / 2) * geometry.pegSpacing.x,
      );
      expect(peg.y).toBe(geometry.latticeTopY - peg.row * geometry.pegSpacing.y);
    }

    expect(bottomRow?.[0]?.x).toBe(geometry.lanes[0]?.bounds.maxX);
    expect(bottomRow?.at(-1)?.x).toBe(geometry.lanes.at(-1)?.bounds.minX);
  });

  it("keeps one constant release point centered above the lattice", () => {
    const geometry = BOARD_GEOMETRY;
    expect(geometry.releasePoint.x).toBe(geometry.boardCenterX);
    expect(geometry.releasePoint.y).toBeGreaterThan(geometry.latticeTopY);
    expect(geometry.physics.firstPegJitterSpeed).toBeGreaterThan(0);
  });

  it("places every bucket wall on a lane boundary", () => {
    const geometry = BOARD_GEOMETRY;
    expect(geometry.bucketWalls).toHaveLength(geometry.laneCount + 1);

    for (const wall of geometry.bucketWalls) {
      const centerX = (wall.bounds.minX + wall.bounds.maxX) / 2;
      expect(centerX).toBe(
        geometry.laneOriginX + wall.boundaryIndex * geometry.laneWidth,
      );
      expect(wall.bounds.maxX - wall.bounds.minX).toBeCloseTo(
        geometry.bucket.wallThickness,
      );
    }
  });

  it("closes only named lanes with a solid cap over each full opening", () => {
    const geometry = withClosedLanes([14, 0, 7]);
    expect(BOARD_GEOMETRY.caps).toEqual([]);
    expect(geometry.closedLaneIndices).toEqual([0, 7, 14]);
    expect(geometry.caps.map((cap) => cap.laneIndex)).toEqual([0, 7, 14]);

    for (const cap of geometry.caps) {
      const lane = geometry.lanes[cap.laneIndex];
      expect(cap.bounds.minX).toBe(lane?.opening.minX);
      expect(cap.bounds.maxX).toBe(lane?.opening.maxX);
      expect(cap.bounds.minY).toBe(
        geometry.bucket.topY - geometry.bucket.capThickness / 2,
      );
      expect(cap.bounds.maxY).toBe(
        geometry.bucket.topY + geometry.bucket.capThickness / 2,
      );
      expect(cap.bounds.maxY - cap.bounds.minY).toBeCloseTo(
        geometry.bucket.capThickness,
      );
    }

    expect(geometry.caps.some((cap) => cap.laneIndex === 1)).toBe(false);
  });

  it("rejects duplicate and out-of-range closed lanes", () => {
    expect(() => withClosedLanes([2, 2])).toThrow("A lane can only be closed once.");
    expect(() => withClosedLanes([-1])).toThrow("Lane index -1 is outside the board.");
    expect(() => withClosedLanes([BOARD_GEOMETRY.laneCount])).toThrow(
      `Lane index ${BOARD_GEOMETRY.laneCount} is outside the board.`,
    );
    expect(() => withClosedLanes([1.5])).toThrow("Lane index 1.5 is outside the board.");
  });

  it("keeps the exported geometry and its derived collections immutable", () => {
    expect(Object.isFrozen(BOARD_GEOMETRY)).toBe(true);
    expect(Object.isFrozen(BOARD_GEOMETRY.lanes)).toBe(true);
    expect(Object.isFrozen(BOARD_GEOMETRY.pegRows)).toBe(true);
    expect(Object.isFrozen(BOARD_GEOMETRY.pegRows[0])).toBe(true);
    expect(Object.isFrozen(BOARD_GEOMETRY.bucketWalls)).toBe(true);
    expect(Object.isFrozen(BOARD_GEOMETRY.releasePoint)).toBe(true);
    expect(Object.isFrozen(BOARD_GEOMETRY.physics)).toBe(true);
  });

  it("requires the shared module wherever source code uses lattice fields", async () => {
    const violations = await findGeometrySourceViolations("src");
    const detail = violations.map(({ path, reason }) => `${path}: ${reason}`).join("\n");
    expect(violations, detail).toEqual([]);
  });

  it("detects numeric geometry in object fields, variables, and assignments", () => {
    expect(declaresNumericGeometry("const rowCount = 14;")).toBe(true);
    expect(declaresNumericGeometry("const capY: number = -0.07;")).toBe(true);
    expect(declaresNumericGeometry("const board = { bucketWallThickness: .12 };")).toBe(true);
    expect(declaresNumericGeometry("laneOriginX = -7.5;")).toBe(true);
    expect(declaresNumericGeometry("const laneWidth = BOARD_GEOMETRY.laneWidth;")).toBe(false);
  });

  it("rejects duplicate geometry files planted in the scan input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lunch-plinko-geometry-scan-"));
    const sceneDirectory = join(directory, "scene");
    const plantedSources = new Map([
      ["object.ts", "export const board = { laneWidth: 1 };\n"],
      ["const.ts", "export const rowCount = 14;\n"],
      ["let.ts", "export let pegRadius = 0.1;\n"],
      ["var.ts", "export var ballRadius = .18;\n"],
      ["typed.ts", "export const capY: number = -0.07;\n"],
      ["assignment.ts", "let laneOriginX: number;\nlaneOriginX = -7.5;\n"],
    ]);

    try {
      await mkdir(join(directory, "drop"), { recursive: true });
      await mkdir(sceneDirectory, { recursive: true });
      await writeFile(join(directory, "drop", "geometry.ts"), "export const rowCount = 14;\n");
      await Promise.all(
        [...plantedSources].map(([name, source]) => writeFile(join(sceneDirectory, name), source)),
      );

      const violations = await findGeometrySourceViolations(directory);
      expect(violations.map(({ path }) => path).sort()).toEqual(
        [...plantedSources.keys()].map((name) => join(sceneDirectory, name)).sort(),
      );
      expect(violations.every(({ reason }) => reason === "declares a second geometry number"))
        .toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
