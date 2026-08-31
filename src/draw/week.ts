import type { Restaurant } from "../config/restaurants.ts";

export interface RolledStateSnapshot {
  readonly weeklyWinners: readonly string[];
  readonly rejectedToday: string | null;
}

export interface InPlayRestaurant {
  readonly laneIndex: number;
  readonly restaurant: Restaurant;
}

export type RecordDirective =
  | { readonly kind: "keep-record" }
  | { readonly kind: "clear-record"; readonly persistBeforeDraw: true };

interface EligibilityBase {
  readonly inPlay: readonly InPlayRestaurant[];
  readonly recordDirective: RecordDirective;
}

export interface ReadyEligibility extends EligibilityBase {
  readonly kind: "ready";
}

export interface NoDropEligibility extends EligibilityBase {
  readonly kind: "no-drop";
}

export type EligibilityResult = ReadyEligibility | NoDropEligibility;

const KEEP_RECORD: RecordDirective = Object.freeze({ kind: "keep-record" });
const CLEAR_RECORD: RecordDirective = Object.freeze({
  kind: "clear-record",
  persistBeforeDraw: true,
});

function lanesFor(restaurants: readonly Restaurant[]): readonly InPlayRestaurant[] {
  return Object.freeze(restaurants.map((restaurant, laneIndex) => Object.freeze({
    laneIndex,
    restaurant,
  })));
}

export function resolveEligibility(
  restaurants: readonly Restaurant[],
  state: RolledStateSnapshot,
): EligibilityResult {
  const fullList = lanesFor(restaurants);
  const weeklyWinners = new Set(state.weeklyWinners);
  const withoutWeeklyWinners = fullList.filter(
    ({ restaurant }) => !weeklyWinners.has(restaurant.name),
  );
  const filtered = Object.freeze(withoutWeeklyWinners.filter(
    ({ restaurant }) => restaurant.name !== state.rejectedToday,
  ));

  if (filtered.length >= 2) {
    return Object.freeze({
      kind: "ready",
      inPlay: filtered,
      recordDirective: KEEP_RECORD,
    });
  }

  if (fullList.length < 2) {
    return Object.freeze({
      kind: "no-drop",
      inPlay: fullList,
      recordDirective: CLEAR_RECORD,
    });
  }

  return Object.freeze({
    kind: "ready",
    inPlay: fullList,
    recordDirective: CLEAR_RECORD,
  });
}
