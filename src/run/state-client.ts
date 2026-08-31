// The client for the server's week-state endpoints, kept apart from the run
// wiring so the small HTTP contract lives in one place and tests against a fake
// fetch. The server owns ISO-week and local-day rollover and keeps the winner
// write idempotent; this only speaks the endpoints. The fetch is injected so a
// unit test drives it without a real server, and main.ts passes the real one.

export interface WeekState {
  /** ISO year-week the record belongs to, e.g. "2026-W35". */
  readonly week: string;
  /** Local ISO date, e.g. "2026-08-26". */
  readonly date: string;
  /** Local ISO date to accepted winner name. Today's is winners[date]. */
  readonly winners: Readonly<Record<string, string>>;
  /** Today's rejected restaurant, or null before a re-drop fires. */
  readonly rejectedToday: string | null;
  /** Whether today's one re-drop is already spent. */
  readonly redropUsed: boolean;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function readState(response: Response, action: string): Promise<WeekState> {
  if (!response.ok) throw new Error(`${action} returned ${response.status}.`);
  return (await response.json()) as WeekState;
}

function postJson(path: string, body: unknown, fetchLike: FetchLike): Promise<Response> {
  return fetchLike(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Read the already-rolled week state. */
export async function fetchWeekState(fetchLike: FetchLike = fetch): Promise<WeekState> {
  return readState(await fetchLike("/api/state"), "Reading the week state");
}

/**
 * Record today's accepted winner. completesRedrop must be set when the write
 * follows a recorded re-drop, which is how the server accepts a second winner
 * for the day. Repeating the same winner is idempotent server-side.
 */
export async function postAcceptedWinner(
  winner: string,
  completesRedrop: boolean,
  fetchLike: FetchLike = fetch,
): Promise<WeekState> {
  const body = completesRedrop ? { winner, completesRedrop: true } : { winner };
  return readState(await postJson("/api/state/accept", body, fetchLike), "Recording the winner");
}

/**
 * Persist today's rejection and mark the re-drop used, in one atomic server
 * write, before the next countdown starts. A reload then cannot re-arm the key
 * or put the rejected restaurant back in play.
 */
export async function postRejection(
  rejected: string,
  fetchLike: FetchLike = fetch,
): Promise<WeekState> {
  return readState(await postJson("/api/state/redrop", { rejected }, fetchLike), "Recording the re-drop");
}

/** The names that have already won this week, which the draw treats as spent. */
export function weeklyWinnerNames(state: WeekState): string[] {
  return Object.values(state.winners);
}

/** Today's accepted winner, or null when today has no record yet. */
export function todaysWinner(state: WeekState): string | null {
  return state.winners[state.date] ?? null;
}
