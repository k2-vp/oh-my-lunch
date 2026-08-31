import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { BOARD_GEOMETRY, withClosedLanes } from "../drop/geometry.ts";
import type { BoardGeometry } from "../drop/geometry.ts";
import {
  K2_THEME_TOKENS,
  createThemeTreatment,
  type ThemeTreatment,
} from "./theme.ts";

// The board scene draws the lattice, the lanes, the buckets, and one ball. Every
// dimension it needs comes from BOARD_GEOMETRY. This module declares no lattice
// number of its own, so the rendered board and the simulated board can never
// disagree about where a peg sits or how wide a lane is. The only numbers here
// are colours, material finish, and camera framing.
//
// The board renders an outcome; it never chooses one. It takes a path that the
// draw and the simulator already produced and moves the ball along it.

// One position on a ball's path, as the simulator reports it. The board reads
// time and position only.
export interface BallPathSample {
  readonly time: number;
  readonly x: number;
  readonly y: number;
}

export interface RenderedBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface RenderedCap {
  readonly laneIndex: number;
  readonly bounds: RenderedBounds;
}

export type LaneVisualState = "in-play" | "spent" | "retired";

export interface RenderedLaneVisual {
  readonly laneIndex: number;
  readonly state: LaneVisualState;
  readonly closed: boolean;
  readonly closureCue: "none" | "filled-bucket" | "dark-lid";
  readonly capBounds: RenderedBounds | null;
  readonly fillBounds: RenderedBounds | null;
  readonly materialColor: number | null;
  readonly materialRoughness: number | null;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface PlanePoint {
  readonly x: number;
  readonly y: number;
}

// Material finish. Speculars come from the scene environment, not from discrete
// lights, which keeps highlights soft rather than hard.
const CLEARCOAT = 1;
const PEG_ROUGHNESS = 0.35;
const PEG_CLEARCOAT_ROUGHNESS = 0.25;
const BALL_ROUGHNESS = 0.16;
const BALL_CLEARCOAT_ROUGHNESS = 0.08;
const WALL_ROUGHNESS = 0.28;
const SPENT_CAP_ROUGHNESS = 0.9;
const SPENT_FILL_ROUGHNESS = 1;
const RETIRED_CAP_ROUGHNESS = 0.42;
const ENVIRONMENT_BLUR = 0.04;

// Framing and depth. z is toward the camera; the board is flat near z = 0.
const CAMERA_DISTANCE = 20;
const CAMERA_NEAR = 1;
const CAMERA_FAR = 100;
const FRAME_PADDING = 1.12;
const BODY_DEPTH = 0.3; // z thickness of walls and caps
const BACKBOARD_Z = -0.6;
const BACKBOARD_MARGIN = 3; // backboard reaches past the framed content
const SPHERE_WIDTH_SEGMENTS = 48;
const SPHERE_HEIGHT_SEGMENTS = 32;

// The soft shadow that follows the ball. It is drawn, not shadow-mapped, so it
// stays soft and cheap and casts no hard edge.
const SHADOW_Z = -0.05;
const SHADOW_OFFSET = 0.22;
const SHADOW_SCALE = 2.6; // multiple of the ball radius
const SHADOW_TEXTURE_SIZE = 128;

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const BACKGROUND_MARK_Z = -0.55;
const BACKGROUND_MARK_WIDTH_RATIO = 0.5;

// Each bucket interior carries a translucent shading panel: a soft sheen at
// the rim fading out, and a faint occlusion pooling at the floor, so the
// bucket reads as a lit cavity instead of a flat gap between walls. The panel
// sits behind the spent-lane fill (-0.55) and stays see-through, so the
// ground and the background mark remain visible.
const BUCKET_PANEL_Z = -0.58;
const BUCKET_PANEL_INSET = 0.045;
const BUCKET_PANEL_OPACITY_LIGHT = 1;
const BUCKET_PANEL_OPACITY_DARK = 0.55;
const BUCKET_SHADING_TEXTURE_HEIGHT = 128;

// Kinetic feedback. The lattice reacts to the ball as it falls: a peg the
// ball grazes flashes and pops for a moment, and the ball pulls a fading
// trail. Everything here is drawn from the path the simulator already chose;
// none of it influences where the ball lands.
const TRAIL_LENGTH = 12;
const TRAIL_MAX_OPACITY = 0.26;
const TRAIL_MAX_SCALE = 1.6; // multiple of the ball radius, at the newest point
const TRAIL_JUMP_RESET = 6; // multiples of the ball radius; a teleport clears it
const PEG_GLOW_RADIUS = 1.45; // multiple of the touching distance
const PEG_GLOW_INTENSITY = 1.1;
const PEG_GLOW_SCALE_POP = 0.28;
const KINETIC_DECAY = 0.94; // per frame
const KINETIC_EPSILON = 0.02;
// The animation loop may skip frames between position feeds, so the trail only
// starts burning down after this many quiet ticks — a real stop, not a gap.
const TRAIL_FEED_GRACE_TICKS = 4;

export interface BoardContentBox {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly width: number;
  readonly height: number;
}

// The rectangle the camera frames: the full lane span across, and from the
// bucket floor up to the release point, so a ball is visible from the moment it
// is released. Derived from geometry, so the frame follows any geometry change.
export function boardContentBox(geometry: BoardGeometry = BOARD_GEOMETRY): BoardContentBox {
  const minX = geometry.laneOriginX;
  const maxX = geometry.laneOriginX + geometry.boardWidth;
  const minY = geometry.bucket.bottomY;
  const maxY = geometry.releasePoint.y;
  return {
    minX,
    maxX,
    minY,
    maxY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    width: maxX - minX,
    height: maxY - minY,
  };
}

// Frame the content box inside the viewport with a margin, keeping the whole
// board on screen at any aspect. The board is height-fit on a wide screen,
// which leaves the wide side margins the references lean on.
export function configureOrthographicCamera(
  camera: THREE.OrthographicCamera,
  width: number,
  height: number,
  geometry: BoardGeometry = BOARD_GEOMETRY,
): void {
  const box = boardContentBox(geometry);
  const targetWidth = box.width * FRAME_PADDING;
  const targetHeight = box.height * FRAME_PADDING;
  const viewAspect = width / height;
  const contentAspect = targetWidth / targetHeight;

  let frustumWidth: number;
  let frustumHeight: number;
  if (viewAspect >= contentAspect) {
    frustumHeight = targetHeight;
    frustumWidth = frustumHeight * viewAspect;
  } else {
    frustumWidth = targetWidth;
    frustumHeight = frustumWidth / viewAspect;
  }

  // The frustum bounds are camera-relative, and the camera sits at the content
  // center, so they are symmetric. Offsetting them by the center as well would
  // shift the view off the board.
  camera.left = -frustumWidth / 2;
  camera.right = frustumWidth / 2;
  camera.top = frustumHeight / 2;
  camera.bottom = -frustumHeight / 2;
  camera.near = CAMERA_NEAR;
  camera.far = CAMERA_FAR;
  camera.position.set(box.centerX, box.centerY, CAMERA_DISTANCE);
  camera.lookAt(box.centerX, box.centerY, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

// Project a point on the board into pixel coordinates, top-left origin. Used by
// the tests to check that rendered geometry lands where the geometry says.
export function projectToScreen(
  camera: THREE.Camera,
  width: number,
  height: number,
  point: { x: number; y: number; z?: number },
): ScreenPoint {
  const ndc = new THREE.Vector3(point.x, point.y, point.z ?? 0).project(camera);
  return {
    x: (ndc.x * 0.5 + 0.5) * width,
    y: (1 - (ndc.y * 0.5 + 0.5)) * height,
  };
}

// Read the ball position at a given time by interpolating between samples.
// At a sample time the result is that sample; between samples it is linear.
export function sampleBallPath(
  path: readonly BallPathSample[],
  time: number,
): PlanePoint {
  const first = path[0];
  if (first === undefined) throw new RangeError("A ball path needs at least one sample.");
  if (time <= first.time || path.length === 1) return { x: first.x, y: first.y };

  const last = path[path.length - 1];
  if (last === undefined) throw new RangeError("A ball path needs at least one sample.");
  if (time >= last.time) return { x: last.x, y: last.y };

  for (let index = 1; index < path.length; index += 1) {
    const before = path[index - 1];
    const after = path[index];
    if (before === undefined || after === undefined) continue;
    if (time <= after.time) {
      const span = after.time - before.time;
      if (span <= 0) return { x: before.x, y: before.y };
      const fraction = (time - before.time) / span;
      return {
        x: before.x + (after.x - before.x) * fraction,
        y: before.y + (after.y - before.y) * fraction,
      };
    }
  }

  return { x: last.x, y: last.y };
}

export interface BoardScene {
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  setTheme(treatment: ThemeTreatment): void;
  getAppearance(): BoardAppearance;
  resize(width: number, height: number): void;
  render(): void;
  setLaneStates(states: readonly LaneVisualState[]): void;
  getLaneVisuals(): readonly RenderedLaneVisual[];
  setClosedLanes(indices: readonly number[]): void;
  getClosedLanes(): readonly number[];
  setBallVisible(visible: boolean): void;
  setBallPosition(x: number, y: number): void;
  placeBallOnPath(path: readonly BallPathSample[], time: number): PlanePoint;
  worldToScreen(point: { x: number; y: number; z?: number }): ScreenPoint;
  getPegWorldPositions(): PlanePoint[];
  getBucketWallBounds(): RenderedBounds[];
  getCapBounds(): RenderedCap[];
  getLaneCenterXs(): number[];
  getBallWorldPosition(): PlanePoint;
  dispose(): void;
}

export interface BoardSceneOptions {
  readonly canvas?: HTMLCanvasElement;
  readonly width?: number;
  readonly height?: number;
  readonly geometry?: BoardGeometry;
  readonly theme?: ThemeTreatment;
}

export interface BoardAppearance {
  readonly mode: ThemeTreatment["mode"];
  readonly ground: number;
  readonly backboard: number;
  readonly peg: number;
  readonly wall: number;
  readonly ball: number;
  readonly spentCap: number;
  readonly retiredCap: number;
  readonly ballEmissiveIntensity: number;
  readonly pegEmissiveIntensity: number;
  readonly environmentIntensity: number;
  readonly backgroundMark: {
    readonly url: string;
    readonly opacity: number;
    readonly loaded: boolean;
  } | null;
}

function boxWorldBounds(mesh: THREE.Object3D): RenderedBounds {
  const box = new THREE.Box3().setFromObject(mesh);
  return { minX: box.min.x, maxX: box.max.x, minY: box.min.y, maxY: box.max.y };
}

function createSoftShadowTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = SHADOW_TEXTURE_SIZE;
  canvas.height = SHADOW_TEXTURE_SIZE;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("The shadow texture needs a 2D canvas context.");

  const center = SHADOW_TEXTURE_SIZE / 2;
  const gradient = context.createRadialGradient(center, center, 0, center, center, center);
  gradient.addColorStop(0, "rgba(0, 0, 0, 1)");
  gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, SHADOW_TEXTURE_SIZE, SHADOW_TEXTURE_SIZE);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// The vertical shading inside a bucket: a sheen at the rim, clear through the
// middle, and a soft occlusion pooling at the floor. Drawn once and shared by
// every bucket panel.
function createBucketShadingTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = BUCKET_SHADING_TEXTURE_HEIGHT;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("The bucket shading texture needs a 2D canvas context.");

  const gradient = context.createLinearGradient(0, 0, 0, BUCKET_SHADING_TEXTURE_HEIGHT);
  gradient.addColorStop(0, "rgba(255, 255, 255, 0.4)");
  gradient.addColorStop(0.45, "rgba(255, 255, 255, 0)");
  gradient.addColorStop(0.78, "rgba(24, 23, 55, 0)");
  gradient.addColorStop(1, "rgba(24, 23, 55, 0.13)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// A white radial glow that a sprite material can tint. The soft shadow texture
// is black and tints to nothing, so the trail needs its own.
function createGlowTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = SHADOW_TEXTURE_SIZE;
  canvas.height = SHADOW_TEXTURE_SIZE;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("The glow texture needs a 2D canvas context.");

  const center = SHADOW_TEXTURE_SIZE / 2;
  const gradient = context.createRadialGradient(center, center, 0, center, center, center);
  gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
  gradient.addColorStop(0.55, "rgba(255, 255, 255, 0.35)");
  gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, SHADOW_TEXTURE_SIZE, SHADOW_TEXTURE_SIZE);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createBoardScene(options: BoardSceneOptions = {}): BoardScene {
  const geometry = options.geometry ?? BOARD_GEOMETRY;
  let treatment = options.theme ?? createThemeTreatment("light", K2_THEME_TOKENS);
  const canvas = options.canvas ?? document.createElement("canvas");
  let width = options.width ?? DEFAULT_WIDTH;
  let height = options.height ?? DEFAULT_HEIGHT;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.setClearColor(treatment.ground, 1);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), ENVIRONMENT_BLUR);
  scene.environment = environment.texture;
  scene.environmentIntensity = treatment.environmentIntensity;
  pmrem.dispose();

  const camera = new THREE.OrthographicCamera();
  configureOrthographicCamera(camera, width, height, geometry);

  // A plain backboard behind the lattice. The ball's soft shadow falls on it.
  // It reaches past the framed content so no edge shows at any aspect.
  const box = boardContentBox(geometry);
  const backboardWidth = box.width + BACKBOARD_MARGIN * geometry.boardWidth;
  const backboardHeight = box.height + BACKBOARD_MARGIN * box.height;
  const backboardMaterial = new THREE.MeshBasicMaterial({
    color: treatment.ground,
  });
  const backboard = new THREE.Mesh(
    new THREE.PlaneGeometry(backboardWidth, backboardHeight),
    backboardMaterial,
  );
  backboard.position.set(box.centerX, box.centerY, BACKBOARD_Z);
  scene.add(backboard);

  // Pegs. One shared geometry and material, placed at every peg the lattice
  // defines, in the same order as geometry.pegs so a collision index matches.
  const pegGeometry = new THREE.SphereGeometry(
    geometry.pegRadius,
    SPHERE_WIDTH_SEGMENTS,
    SPHERE_HEIGHT_SEGMENTS,
  );
  const pegMaterial = new THREE.MeshPhysicalMaterial({
    color: treatment.peg,
    emissive: treatment.peg,
    emissiveIntensity: treatment.pegEmissiveIntensity,
    roughness: PEG_ROUGHNESS,
    metalness: 0,
    clearcoat: CLEARCOAT,
    clearcoatRoughness: PEG_CLEARCOAT_ROUGHNESS,
  });
  // Every peg gets its own clone of the material, so one peg can flash while
  // its neighbours stay quiet. The template material stays the appearance
  // record and the single place the theme writes to.
  const pegSkins: THREE.MeshPhysicalMaterial[] = [];
  const pegMeshes: THREE.Mesh[] = geometry.pegs.map((peg) => {
    const skin = pegMaterial.clone();
    pegSkins.push(skin);
    const mesh = new THREE.Mesh(pegGeometry, skin);
    mesh.position.set(peg.x, peg.y, 0);
    scene.add(mesh);
    return mesh;
  });
  const pegGlow = new Float32Array(geometry.pegs.length);

  // Bucket walls. One capsule per boundary: a rounded rod reads with the same
  // curved-surface depth as the pegs and the ball, where a flat box reads as a
  // slab, and its rounded top finishes the divider flush with the bucket rim
  // instead of crowding the bottom peg row. The capsule's bounding box is the
  // exact wall envelope the simulation collides with: radius is half the wall
  // thickness and the cylinder section makes up the rest of the height.
  const wallHeight = geometry.bucket.topY - geometry.bucket.bottomY;
  const wallRadius = geometry.bucket.wallThickness / 2;
  const wallGeometry = new THREE.CapsuleGeometry(
    wallRadius,
    wallHeight - geometry.bucket.wallThickness,
    SPHERE_HEIGHT_SEGMENTS,
    SPHERE_WIDTH_SEGMENTS,
  );
  const wallMaterial = new THREE.MeshPhysicalMaterial({
    color: treatment.wall,
    emissive: treatment.wall,
    emissiveIntensity: treatment.pegEmissiveIntensity,
    roughness: WALL_ROUGHNESS,
    metalness: 0,
    clearcoat: CLEARCOAT,
    clearcoatRoughness: PEG_CLEARCOAT_ROUGHNESS,
  });
  const wallMeshes: THREE.Mesh[] = geometry.bucketWalls.map((wall) => {
    const mesh = new THREE.Mesh(wallGeometry, wallMaterial);
    const centerX = (wall.bounds.minX + wall.bounds.maxX) / 2;
    const centerY = (wall.bounds.minY + wall.bounds.maxY) / 2;
    mesh.position.set(centerX, centerY, 0);
    scene.add(mesh);
    return mesh;
  });

  // Bucket shading panels.
  const bucketShadingTexture = createBucketShadingTexture();
  const panelMaterial = new THREE.MeshBasicMaterial({
    map: bucketShadingTexture,
    transparent: true,
    opacity: treatment.mode === "light"
      ? BUCKET_PANEL_OPACITY_LIGHT
      : BUCKET_PANEL_OPACITY_DARK,
    depthWrite: false,
  });
  const bucketHeight = geometry.bucket.topY - geometry.bucket.bottomY;
  const panelMeshes: THREE.Mesh[] = [];
  for (const lane of geometry.lanes) {
    const panelWidth = lane.opening.maxX - lane.opening.minX - BUCKET_PANEL_INSET * 2;
    const panelHeight = bucketHeight - BUCKET_PANEL_INSET * 2;
    const centerY = (geometry.bucket.topY + geometry.bucket.bottomY) / 2;
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(panelWidth, panelHeight),
      panelMaterial,
    );
    panel.position.set(lane.centerX, centerY, BUCKET_PANEL_Z);
    scene.add(panel);
    panelMeshes.push(panel);
  }

  // Caps close lanes. A capped lane cannot receive a ball, so closing a lane is
  // geometry, not a light state. Caps are rebuilt whenever the closed set changes.
  const spentCapMaterial = new THREE.MeshPhysicalMaterial({
    color: treatment.spentCap,
    roughness: SPENT_CAP_ROUGHNESS,
    metalness: 0,
    clearcoat: CLEARCOAT,
    clearcoatRoughness: PEG_CLEARCOAT_ROUGHNESS,
  });
  const retiredCapMaterial = new THREE.MeshPhysicalMaterial({
    color: treatment.retiredCap,
    roughness: RETIRED_CAP_ROUGHNESS,
    metalness: 0,
    clearcoat: CLEARCOAT,
    clearcoatRoughness: PEG_CLEARCOAT_ROUGHNESS,
  });
  const spentFillMaterial = new THREE.MeshStandardMaterial({
    color: treatment.spentFill,
    roughness: SPENT_FILL_ROUGHNESS,
    metalness: 0,
  });
  const capGroup = new THREE.Group();
  scene.add(capGroup);
  const laneCueGroup = new THREE.Group();
  scene.add(laneCueGroup);
  const capMeshes: {
    laneIndex: number;
    state: Exclude<LaneVisualState, "in-play">;
    mesh: THREE.Mesh;
    material: THREE.MeshPhysicalMaterial;
  }[] = [];
  const fillMeshes: { laneIndex: number; mesh: THREE.Mesh }[] = [];
  let closedLaneIndices: readonly number[] = [];
  let laneVisualStates: readonly LaneVisualState[] = Object.freeze(
    Array.from({ length: geometry.laneCount }, () => "in-play" as const),
  );

  function clearLaneClosures(): void {
    for (const entry of capMeshes) {
      capGroup.remove(entry.mesh);
      entry.mesh.geometry.dispose();
    }
    capMeshes.length = 0;
    for (const entry of fillMeshes) {
      laneCueGroup.remove(entry.mesh);
      entry.mesh.geometry.dispose();
    }
    fillMeshes.length = 0;
  }

  function setLaneStates(states: readonly LaneVisualState[]): void {
    if (states.length !== geometry.laneCount) {
      throw new RangeError(`Lane state count must be ${geometry.laneCount}.`);
    }
    for (const state of states) {
      if (state !== "in-play" && state !== "spent" && state !== "retired") {
        throw new RangeError(`Unknown lane state: ${String(state)}.`);
      }
    }

    clearLaneClosures();
    laneVisualStates = Object.freeze([...states]);
    const closed = laneVisualStates.flatMap((state, laneIndex) =>
      state === "in-play" ? [] : [laneIndex]
    );
    const capped = withClosedLanes(closed, geometry);
    closedLaneIndices = capped.closedLaneIndices;
    for (const cap of capped.caps) {
      const state = laneVisualStates[cap.laneIndex];
      if (state === undefined || state === "in-play") {
        throw new Error(`Closed lane ${cap.laneIndex} needs a closed visual state.`);
      }
      const material = state === "spent" ? spentCapMaterial : retiredCapMaterial;
      const capWidth = cap.bounds.maxX - cap.bounds.minX;
      const capHeight = cap.bounds.maxY - cap.bounds.minY;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(capWidth, capHeight, BODY_DEPTH),
        material,
      );
      mesh.position.set(
        (cap.bounds.minX + cap.bounds.maxX) / 2,
        (cap.bounds.minY + cap.bounds.maxY) / 2,
        0,
      );
      capGroup.add(mesh);
      capMeshes.push({ laneIndex: cap.laneIndex, state, mesh, material });

      if (state === "spent") {
        const lane = geometry.lanes[cap.laneIndex];
        if (lane === undefined) throw new RangeError(`Lane ${cap.laneIndex} is missing.`);
        const fillWidth = lane.opening.maxX - lane.opening.minX;
        const fillHeight = lane.opening.maxY - lane.opening.minY;
        const fill = new THREE.Mesh(
          new THREE.BoxGeometry(fillWidth, fillHeight, BODY_DEPTH / 4),
          spentFillMaterial,
        );
        fill.position.set(
          lane.centerX,
          (lane.opening.minY + lane.opening.maxY) / 2,
          BACKBOARD_Z + BODY_DEPTH / 6,
        );
        laneCueGroup.add(fill);
        fillMeshes.push({ laneIndex: cap.laneIndex, mesh: fill });
      }
    }
  }

  function setClosedLanes(indices: readonly number[]): void {
    const closed = withClosedLanes(indices, geometry).closedLaneIndices;
    const closedSet = new Set(closed);
    setLaneStates(
      Array.from(
        { length: geometry.laneCount },
        (_, laneIndex): LaneVisualState => closedSet.has(laneIndex) ? "retired" : "in-play",
      ),
    );
  }

  // The ball and its soft shadow.
  const ballGeometry = new THREE.SphereGeometry(
    geometry.ballRadius,
    SPHERE_WIDTH_SEGMENTS,
    SPHERE_HEIGHT_SEGMENTS,
  );
  const ballMaterial = new THREE.MeshPhysicalMaterial({
    color: treatment.ball,
    emissive: treatment.ball,
    emissiveIntensity: treatment.ballEmissiveIntensity,
    roughness: BALL_ROUGHNESS,
    metalness: 0,
    clearcoat: CLEARCOAT,
    clearcoatRoughness: BALL_CLEARCOAT_ROUGHNESS,
  });
  const ball = new THREE.Mesh(ballGeometry, ballMaterial);
  scene.add(ball);

  const shadowTexture = createSoftShadowTexture();
  const shadowMaterial = new THREE.SpriteMaterial({
    map: shadowTexture,
    color: treatment.shadow,
    opacity: treatment.shadowOpacity,
    transparent: true,
    depthWrite: false,
  });
  const shadow = new THREE.Sprite(shadowMaterial);
  const shadowSize = geometry.ballRadius * SHADOW_SCALE;
  shadow.scale.set(shadowSize, shadowSize, 1);
  scene.add(shadow);

  // The ball's trail: one tintable sprite per recent position, newest largest.
  const trailTexture = createGlowTexture();
  const trailSprites: THREE.Sprite[] = [];
  for (let index = 0; index < TRAIL_LENGTH; index += 1) {
    const material = new THREE.SpriteMaterial({
      map: trailTexture,
      color: treatment.ink,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.visible = false;
    scene.add(sprite);
    trailSprites.push(sprite);
  }
  const trailPoints: { x: number; y: number }[] = [];
  let ticksSinceTrailFeed = TRAIL_FEED_GRACE_TICKS;

  function applyTrail(): void {
    for (let index = 0; index < trailSprites.length; index += 1) {
      const sprite = trailSprites[index];
      const point = trailPoints[index];
      if (sprite === undefined) continue;
      if (point === undefined) {
        sprite.visible = false;
        continue;
      }
      const falloff = (1 - index / TRAIL_LENGTH) ** 2;
      const size = geometry.ballRadius * TRAIL_MAX_SCALE * (0.35 + 0.65 * falloff);
      sprite.visible = true;
      sprite.position.set(point.x, point.y, -geometry.ballRadius / 2);
      sprite.scale.set(size, size, 1);
      sprite.material.opacity = TRAIL_MAX_OPACITY * falloff;
    }
  }

  function applyPegGlow(): void {
    for (let index = 0; index < pegSkins.length; index += 1) {
      const skin = pegSkins[index];
      const mesh = pegMeshes[index];
      const glow = pegGlow[index] ?? 0;
      if (skin === undefined || mesh === undefined) continue;
      skin.emissiveIntensity = treatment.pegEmissiveIntensity + glow * PEG_GLOW_INTENSITY;
      const scale = 1 + glow * PEG_GLOW_SCALE_POP;
      mesh.scale.set(scale, scale, scale);
    }
  }

  // The kinetic loop keeps decaying glows and trail after the drop animation
  // stops feeding positions, so nothing freezes mid-flash. It runs only while
  // there is something left to fade.
  let kineticFrame: number | null = null;

  function kineticsActive(): boolean {
    if (trailPoints.length > 0) return true;
    for (const glow of pegGlow) if (glow > KINETIC_EPSILON) return true;
    return false;
  }

  function kineticTick(): void {
    kineticFrame = null;
    for (let index = 0; index < pegGlow.length; index += 1) {
      const glow = (pegGlow[index] ?? 0) * KINETIC_DECAY;
      pegGlow[index] = glow < KINETIC_EPSILON ? 0 : glow;
    }
    // While the animation feeds positions the trail follows the ball; once the
    // feed has stopped for real, the trail burns down from its tail.
    ticksSinceTrailFeed += 1;
    if (ticksSinceTrailFeed > TRAIL_FEED_GRACE_TICKS) trailPoints.pop();
    applyPegGlow();
    applyTrail();
    renderer.render(scene, camera);
    if (kineticsActive()) ensureKinetics();
  }

  function ensureKinetics(): void {
    if (kineticFrame === null) kineticFrame = requestAnimationFrame(kineticTick);
  }

  function resetKinetics(): void {
    if (kineticFrame !== null) {
      cancelAnimationFrame(kineticFrame);
      kineticFrame = null;
    }
    trailPoints.length = 0;
    ticksSinceTrailFeed = TRAIL_FEED_GRACE_TICKS;
    pegGlow.fill(0);
    applyPegGlow();
    applyTrail();
  }

  let backgroundMarkMaterial: THREE.MeshBasicMaterial | null = null;
  let backgroundMarkTexture: THREE.Texture | null = null;
  let backgroundMarkMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;
  let backgroundMarkRequest = 0;
  const backgroundMarkLoader = new THREE.TextureLoader();

  function clearBackgroundMark(): void {
    backgroundMarkRequest += 1;
    if (backgroundMarkMesh !== null) {
      scene.remove(backgroundMarkMesh);
      backgroundMarkMesh.geometry.dispose();
    }
    backgroundMarkMaterial?.dispose();
    backgroundMarkTexture?.dispose();
    backgroundMarkMesh = null;
    backgroundMarkMaterial = null;
    backgroundMarkTexture = null;
  }

  function loadBackgroundMark(): void {
    clearBackgroundMark();
    const mark = treatment.backgroundMark;
    if (mark === null) return;
    const request = backgroundMarkRequest;
    backgroundMarkLoader.load(
      mark.url,
      (texture) => {
        if (request !== backgroundMarkRequest) {
          texture.dispose();
          return;
        }
        texture.colorSpace = THREE.SRGBColorSpace;
        const image = texture.image as { width?: number; height?: number };
        const aspect = (image.width ?? 1) / Math.max(1, image.height ?? 1);
        const markWidth = box.width * BACKGROUND_MARK_WIDTH_RATIO;
        backgroundMarkTexture = texture;
        backgroundMarkMaterial = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          opacity: mark.opacity,
          depthWrite: false,
          toneMapped: false,
        });
        backgroundMarkMesh = new THREE.Mesh(
          new THREE.PlaneGeometry(markWidth, markWidth / aspect),
          backgroundMarkMaterial,
        );
        backgroundMarkMesh.name = "background-mark";
        backgroundMarkMesh.position.set(box.centerX, box.centerY, BACKGROUND_MARK_Z);
        scene.add(backgroundMarkMesh);
        renderer.render(scene, camera);
      },
      undefined,
      () => {
        if (request === backgroundMarkRequest) {
          console.error("[plinko] background-mark-unavailable", { url: mark.url });
        }
      },
    );
  }

  function setTheme(nextTreatment: ThemeTreatment): void {
    treatment = nextTreatment;
    canvas.dataset.theme = treatment.mode;
    renderer.setClearColor(treatment.ground, 1);
    scene.environmentIntensity = treatment.environmentIntensity;
    backboardMaterial.color.set(treatment.ground);
    pegMaterial.color.set(treatment.peg);
    pegMaterial.emissive.set(treatment.peg);
    pegMaterial.emissiveIntensity = treatment.pegEmissiveIntensity;
    for (const skin of pegSkins) {
      skin.color.set(treatment.peg);
      skin.emissive.set(treatment.peg);
      skin.emissiveIntensity = treatment.pegEmissiveIntensity;
    }
    pegGlow.fill(0);
    applyPegGlow();
    for (const sprite of trailSprites) sprite.material.color.set(treatment.ink);
    wallMaterial.color.set(treatment.wall);
    wallMaterial.emissive.set(treatment.wall);
    wallMaterial.emissiveIntensity = treatment.pegEmissiveIntensity;
    panelMaterial.opacity = treatment.mode === "light"
      ? BUCKET_PANEL_OPACITY_LIGHT
      : BUCKET_PANEL_OPACITY_DARK;
    spentCapMaterial.color.set(treatment.spentCap);
    retiredCapMaterial.color.set(treatment.retiredCap);
    spentFillMaterial.color.set(treatment.spentFill);
    ballMaterial.color.set(treatment.ball);
    ballMaterial.emissive.set(treatment.ball);
    ballMaterial.emissiveIntensity = treatment.ballEmissiveIntensity;
    shadowMaterial.color.set(treatment.shadow);
    shadowMaterial.opacity = treatment.shadowOpacity;
    loadBackgroundMark();
  }

  function setBallPosition(x: number, y: number): void {
    ball.position.set(x, y, 0);
    shadow.position.set(x + SHADOW_OFFSET, y - SHADOW_OFFSET, SHADOW_Z);
    if (!ball.visible) return;

    // Feed the trail. A jump longer than a few ball widths is a new drop, not
    // motion, so the old trail does not smear across the board.
    const newest = trailPoints[0];
    if (
      newest !== undefined
      && Math.hypot(x - newest.x, y - newest.y) > geometry.ballRadius * TRAIL_JUMP_RESET
    ) {
      trailPoints.length = 0;
    }
    trailPoints.unshift({ x, y });
    if (trailPoints.length > TRAIL_LENGTH) trailPoints.pop();
    ticksSinceTrailFeed = 0;

    // Light up any peg the ball is grazing.
    const trigger = (geometry.pegRadius + geometry.ballRadius) * PEG_GLOW_RADIUS;
    for (let index = 0; index < geometry.pegs.length; index += 1) {
      const peg = geometry.pegs[index];
      if (peg === undefined) continue;
      if (Math.hypot(x - peg.x, y - peg.y) < trigger) pegGlow[index] = 1;
    }
    applyPegGlow();
    applyTrail();
    ensureKinetics();
  }

  setBallPosition(geometry.releasePoint.x, geometry.releasePoint.y);
  setTheme(treatment);

  function setBallVisible(visible: boolean): void {
    ball.visible = visible;
    shadow.visible = visible;
    if (!visible) resetKinetics();
  }

  function resize(nextWidth: number, nextHeight: number): void {
    width = nextWidth;
    height = nextHeight;
    renderer.setSize(width, height, false);
    configureOrthographicCamera(camera, width, height, geometry);
  }

  const worldPoint = new THREE.Vector3();

  // Bring every object's world matrix up to date before a test reads a position.
  // Matrices are otherwise refreshed only during render, so an accessor called
  // before the first render would read a stale position.
  function syncWorld(): void {
    scene.updateMatrixWorld(true);
  }

  return {
    scene,
    camera,
    renderer,
    canvas,
    setTheme,
    getAppearance() {
      return {
        mode: treatment.mode,
        ground: renderer.getClearColor(new THREE.Color()).getHex(),
        backboard: backboardMaterial.color.getHex(),
        peg: pegMaterial.color.getHex(),
        wall: wallMaterial.color.getHex(),
        ball: ballMaterial.color.getHex(),
        spentCap: spentCapMaterial.color.getHex(),
        retiredCap: retiredCapMaterial.color.getHex(),
        ballEmissiveIntensity: ballMaterial.emissiveIntensity,
        pegEmissiveIntensity: pegMaterial.emissiveIntensity,
        environmentIntensity: scene.environmentIntensity,
        backgroundMark: treatment.backgroundMark === null
          ? null
          : {
            url: treatment.backgroundMark.url,
            opacity: backgroundMarkMaterial?.opacity ?? treatment.backgroundMark.opacity,
            loaded: backgroundMarkMesh !== null,
          },
      };
    },
    resize,
    render() {
      renderer.render(scene, camera);
    },
    setLaneStates,
    getLaneVisuals() {
      syncWorld();
      return laneVisualStates.map((state, laneIndex): RenderedLaneVisual => {
        const cap = capMeshes.find((entry) => entry.laneIndex === laneIndex);
        const fill = fillMeshes.find((entry) => entry.laneIndex === laneIndex);
        return {
          laneIndex,
          state,
          closed: state !== "in-play",
          closureCue: state === "spent"
            ? "filled-bucket"
            : state === "retired" ? "dark-lid" : "none",
          capBounds: cap === undefined ? null : boxWorldBounds(cap.mesh),
          fillBounds: fill === undefined ? null : boxWorldBounds(fill.mesh),
          materialColor: cap?.material.color.getHex() ?? null,
          materialRoughness: cap?.material.roughness ?? null,
        };
      });
    },
    setClosedLanes,
    getClosedLanes() {
      return closedLaneIndices;
    },
    setBallVisible,
    setBallPosition,
    placeBallOnPath(path, time) {
      const point = sampleBallPath(path, time);
      setBallPosition(point.x, point.y);
      return point;
    },
    worldToScreen(point) {
      return projectToScreen(camera, width, height, point);
    },
    getPegWorldPositions() {
      syncWorld();
      return pegMeshes.map((mesh) => {
        mesh.getWorldPosition(worldPoint);
        return { x: worldPoint.x, y: worldPoint.y };
      });
    },
    getBucketWallBounds() {
      syncWorld();
      return wallMeshes.map((mesh) => boxWorldBounds(mesh));
    },
    getCapBounds() {
      syncWorld();
      return capMeshes.map((entry) => ({
        laneIndex: entry.laneIndex,
        bounds: boxWorldBounds(entry.mesh),
      }));
    },
    getLaneCenterXs() {
      syncWorld();
      const wallCenters = wallMeshes.map((mesh) => {
        mesh.getWorldPosition(worldPoint);
        return worldPoint.x;
      });
      const centers: number[] = [];
      for (let index = 0; index + 1 < wallCenters.length; index += 1) {
        const left = wallCenters[index];
        const right = wallCenters[index + 1];
        if (left === undefined || right === undefined) continue;
        centers.push((left + right) / 2);
      }
      return centers;
    },
    getBallWorldPosition() {
      syncWorld();
      ball.getWorldPosition(worldPoint);
      return { x: worldPoint.x, y: worldPoint.y };
    },
    dispose() {
      if (kineticFrame !== null) cancelAnimationFrame(kineticFrame);
      clearBackgroundMark();
      clearLaneClosures();
      pegGeometry.dispose();
      pegMaterial.dispose();
      for (const skin of pegSkins) skin.dispose();
      for (const sprite of trailSprites) sprite.material.dispose();
      trailTexture.dispose();
      wallGeometry.dispose();
      wallMaterial.dispose();
      panelMaterial.dispose();
      bucketShadingTexture.dispose();
      for (const mesh of panelMeshes) mesh.geometry.dispose();
      spentCapMaterial.dispose();
      retiredCapMaterial.dispose();
      spentFillMaterial.dispose();
      ballGeometry.dispose();
      ballMaterial.dispose();
      backboard.geometry.dispose();
      backboardMaterial.dispose();
      shadowTexture.dispose();
      shadowMaterial.dispose();
      environment.texture.dispose();
      renderer.dispose();
      // Free the WebGL context so a test suite that builds several boards does
      // not run into the browser's context limit.
      renderer.forceContextLoss();
    },
  };
}
