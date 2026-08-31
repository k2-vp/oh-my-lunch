import type { InPlayRestaurant } from "./week.ts";

function indexForRandomValue(count: number, randomValue: number): number {
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
    throw new RangeError("Random value must be at least 0 and below 1.");
  }

  for (let index = 1; index < count; index += 1) {
    if (randomValue < index / count) return index - 1;
  }
  return count - 1;
}

function drawFrom(
  candidates: readonly InPlayRestaurant[],
  randomValue: number,
): InPlayRestaurant {
  const index = indexForRandomValue(candidates.length, randomValue);
  const target = candidates[index];
  if (target === undefined) throw new RangeError("The random value did not map to a restaurant.");
  return target;
}

export function drawDestination(
  inPlay: readonly InPlayRestaurant[],
  randomValue: number,
): InPlayRestaurant {
  if (inPlay.length < 2) {
    throw new RangeError("A draw needs at least two restaurants in play.");
  }

  return drawFrom(inPlay, randomValue);
}

export function drawTieDestination(
  tied: readonly InPlayRestaurant[],
  randomValue: number,
): InPlayRestaurant {
  if (tied.length < 2) {
    throw new RangeError("A tie draw needs at least two restaurants.");
  }

  return drawFrom(tied, randomValue);
}
