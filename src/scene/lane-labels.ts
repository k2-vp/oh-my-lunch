import * as THREE from "three";
import type { Restaurant } from "../config/restaurants.ts";
import { BOARD_GEOMETRY, type BoardGeometry } from "../drop/geometry.ts";
import type { BoardScene } from "./board.ts";
import { K2_THEME_TOKENS } from "./theme.ts";
import {
  createLabelTexture,
  layoutLabel,
  type LabelBox,
  type LabelLayout,
} from "./labels.ts";

const LABEL_Z = -0.5;
const MIN_LABEL_FONT_PX = 1;

export interface LaneLabelEntry {
  readonly laneIndex: number;
  readonly name: string;
  readonly displayedText: string;
  readonly layout: LabelLayout;
}

export interface LaneLabelLayer {
  readonly entries: readonly LaneLabelEntry[];
  setColor(color: string): void;
  getColor(): string;
  dispose(): void;
}

export interface LaneLabelOptions {
  readonly color?: string;
}

function pixelsPerWorldUnit(board: BoardScene): number {
  const origin = board.worldToScreen({ x: 0, y: 0 });
  const oneUnit = board.worldToScreen({ x: 1, y: 0 });
  return Math.abs(oneUnit.x - origin.x);
}

// Add the fixed restaurant names to the board. This helper keeps label setup in
// the scene layer so tests and run wiring use the same real canvas textures.
export function createLaneLabelLayer(
  board: BoardScene,
  restaurants: readonly Restaurant[],
  geometry: BoardGeometry = BOARD_GEOMETRY,
  options: LaneLabelOptions = {},
): LaneLabelLayer {
  if (restaurants.length > geometry.laneCount) {
    throw new RangeError(`The board has room for ${geometry.laneCount} restaurant labels.`);
  }

  const perUnit = pixelsPerWorldUnit(board);
  const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  const bucketHeight = geometry.bucket.topY - geometry.bucket.bottomY;
  const centerY = (geometry.bucket.topY + geometry.bucket.bottomY) / 2;
  const meshes: THREE.Mesh[] = [];
  const materials: THREE.MeshBasicMaterial[] = [];
  const textures: THREE.CanvasTexture[] = [];
  const entries: LaneLabelEntry[] = [];
  let color = options.color ?? K2_THEME_TOKENS.ink;

  const prepared = restaurants.flatMap((restaurant, laneIndex) => {
    const lane = geometry.lanes[laneIndex];
    if (lane === undefined) return [];
    const openingWidth = lane.opening.maxX - lane.opening.minX;
    const box: LabelBox = {
      widthPx: openingWidth * perUnit,
      heightPx: bucketHeight * perUnit,
    };
    const autoFit = layoutLabel(restaurant, box, {
      devicePixelRatio: dpr,
      minFontSizePx: MIN_LABEL_FONT_PX,
    });
    if (!autoFit.fitsWidth || !autoFit.fitsHeight) {
      throw new RangeError(`The label for ${restaurant.name} does not fit its lane.`);
    }
    return [{ restaurant, laneIndex, lane, openingWidth, box, autoFit }];
  });

  const sharedFontSize = prepared.length === 0
    ? MIN_LABEL_FONT_PX
    : Math.min(...prepared.map(({ autoFit }) => autoFit.fontSizePx));

  prepared.forEach(({ restaurant, laneIndex, lane, openingWidth, box }) => {
    const { texture, layout } = createLabelTexture(
      restaurant,
      box,
      {
        devicePixelRatio: dpr,
        minFontSizePx: sharedFontSize,
        maxFontSizePx: sharedFontSize,
        color,
      },
    );
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(openingWidth, bucketHeight),
      material,
    );
    mesh.position.set(lane.centerX, centerY, LABEL_Z);
    board.scene.add(mesh);
    meshes.push(mesh);
    materials.push(material);
    textures.push(texture);
    entries.push({
      laneIndex,
      name: restaurant.name,
      displayedText: layout.text,
      layout,
    });
  });

  return {
    entries: Object.freeze(entries),
    setColor(nextColor) {
      if (nextColor === color) return;
      color = nextColor;
      prepared.forEach(({ restaurant, box }, index) => {
        const material = materials[index];
        const previousTexture = textures[index];
        if (material === undefined || previousTexture === undefined) return;
        const { texture } = createLabelTexture(restaurant, box, {
          devicePixelRatio: dpr,
          minFontSizePx: sharedFontSize,
          maxFontSizePx: sharedFontSize,
          color,
        });
        material.map = texture;
        material.needsUpdate = true;
        textures[index] = texture;
        previousTexture.dispose();
      });
      board.render();
    },
    getColor: () => color,
    dispose() {
      for (const mesh of meshes) {
        board.scene.remove(mesh);
        mesh.geometry.dispose();
      }
      for (const material of materials) material.dispose();
      for (const texture of textures) texture.dispose();
    },
  };
}
