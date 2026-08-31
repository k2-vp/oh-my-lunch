import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const CORRUPT_STATE_DIAGNOSTIC = "state-corrupt-recovered";

export interface StateSnapshot {
  readonly week: string;
  readonly date: string;
  readonly winners: Readonly<Record<string, string>>;
  readonly rejectedToday: string | null;
  readonly redropUsed: boolean;
}

export interface StateDiagnostic {
  readonly name: typeof CORRUPT_STATE_DIAGNOSTIC;
  readonly stateFile: string;
  readonly recoveryFile: string;
  readonly message: string;
}

export interface StateStore {
  read(): Promise<StateSnapshot>;
  acceptWinner(
    winner: string,
    options?: { readonly completesRedrop?: boolean },
  ): Promise<StateSnapshot>;
  recordRedrop(rejected: string): Promise<StateSnapshot>;
  resetWeek(): Promise<StateSnapshot>;
}

interface StateStoreOptions {
  readonly file: string;
  readonly now?: () => Date;
  readonly diagnostic?: (diagnostic: StateDiagnostic) => void;
}

interface CurrentIdentity {
  readonly week: string;
  readonly date: string;
}

export class StateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateConflictError";
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function currentIdentity(now: Date): CurrentIdentity {
  if (Number.isNaN(now.getTime())) {
    throw new TypeError("The state clock returned an invalid date.");
  }

  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  const date = `${year}-${pad(month + 1)}-${pad(day)}`;

  // Work from the local calendar fields in UTC. This avoids daylight-saving
  // gaps while keeping the week tied to the date people see on the board.
  const thursday = new Date(Date.UTC(year, month, day));
  const weekday = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - weekday);
  const isoYear = thursday.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(
    ((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );

  return { week: `${isoYear}-W${pad(week)}`, date };
}

function freshState(identity: CurrentIdentity): StateSnapshot {
  return {
    week: identity.week,
    date: identity.date,
    winners: {},
    rejectedToday: null,
    redropUsed: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseState(text: string): StateSnapshot {
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value)) {
    throw new TypeError("State must be a JSON object.");
  }
  if (typeof value.week !== "string" || !/^\d{4}-W\d{2}$/.test(value.week)) {
    throw new TypeError("State week must use ISO year-week form.");
  }
  if (typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) {
    throw new TypeError("State date must use local ISO date form.");
  }
  if (!isRecord(value.winners)) {
    throw new TypeError("State winners must be an object.");
  }

  const winners: Record<string, string> = {};
  for (const [date, winner] of Object.entries(value.winners)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || typeof winner !== "string" || winner.trim() === "") {
      throw new TypeError("Each state winner needs a local ISO date and restaurant name.");
    }
    winners[date] = winner;
  }

  if (value.rejectedToday !== null && typeof value.rejectedToday !== "string") {
    throw new TypeError("State rejectedToday must be a restaurant name or null.");
  }
  if (typeof value.rejectedToday === "string" && value.rejectedToday.trim() === "") {
    throw new TypeError("State rejectedToday cannot be empty.");
  }
  if (typeof value.redropUsed !== "boolean") {
    throw new TypeError("State redropUsed must be a boolean.");
  }

  return {
    week: value.week,
    date: value.date,
    winners,
    rejectedToday: value.rejectedToday,
    redropUsed: value.redropUsed,
  };
}

function cloneState(state: StateSnapshot): StateSnapshot {
  return { ...state, winners: { ...state.winners } };
}

function sameState(left: StateSnapshot, right: StateSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function atomicWrite(file: string, state: StateSnapshot): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true });
  const temporaryFile = join(
    directory,
    `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(temporaryFile, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryFile, file);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

function recoveryFileName(file: string): string {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  return `${file}.corrupt-${stamp}-${randomUUID()}`;
}

function defaultDiagnostic(diagnostic: StateDiagnostic): void {
  console.error(
    `${diagnostic.name}: ${diagnostic.message} Recovery file: ${diagnostic.recoveryFile}`,
  );
}

function winnerName(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a restaurant name.`);
  }
  return value;
}

export function createStateStore(options: StateStoreOptions): StateStore {
  const now = options.now ?? (() => new Date());
  const diagnostic = options.diagnostic ?? defaultDiagnostic;
  let queue: Promise<void> = Promise.resolve();

  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  const recover = async (identity: CurrentIdentity): Promise<StateSnapshot> => {
    const recoveryFile = recoveryFileName(options.file);
    await rename(options.file, recoveryFile);
    const event: StateDiagnostic = {
      name: CORRUPT_STATE_DIAGNOSTIC,
      stateFile: options.file,
      recoveryFile,
      message: "Preserved unreadable weekly state and started a fresh record.",
    };
    try {
      diagnostic(event);
    } catch (error) {
      console.error(`${CORRUPT_STATE_DIAGNOSTIC}: The diagnostic handler failed.`, error);
    }
    const state = freshState(identity);
    await atomicWrite(options.file, state);
    return state;
  };

  const load = async (): Promise<StateSnapshot> => {
    const identity = currentIdentity(now());
    let text: string;
    try {
      text = await readFile(options.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const state = freshState(identity);
        await atomicWrite(options.file, state);
        return state;
      }
      return recover(identity);
    }

    let stored: StateSnapshot;
    try {
      stored = parseState(text);
    } catch {
      return recover(identity);
    }

    let rolled = stored;
    if (stored.week !== identity.week) {
      rolled = freshState(identity);
    } else if (stored.date !== identity.date) {
      rolled = {
        ...stored,
        date: identity.date,
        rejectedToday: null,
        redropUsed: false,
      };
    }

    if (!sameState(stored, rolled)) {
      await atomicWrite(options.file, rolled);
    }
    return rolled;
  };

  const save = async (state: StateSnapshot): Promise<StateSnapshot> => {
    await atomicWrite(options.file, state);
    return cloneState(state);
  };

  return {
    read: () => run(async () => cloneState(await load())),

    acceptWinner: (winner, acceptOptions = {}) => run(async () => {
      const name = winnerName(winner, "winner");
      const state = await load();
      const accepted = state.winners[state.date];

      if (accepted === name) {
        return cloneState(state);
      }

      if (accepted !== undefined) {
        const canReplace = acceptOptions.completesRedrop === true
          && state.redropUsed
          && state.rejectedToday === accepted;
        if (!canReplace) {
          throw new StateConflictError("Another winner is already accepted for this date.");
        }
      } else if (acceptOptions.completesRedrop === true) {
        if (!state.redropUsed || state.rejectedToday === null) {
          throw new StateConflictError("No recorded re-drop is waiting for a winner.");
        }
      }

      if (state.redropUsed && state.rejectedToday === name) {
        throw new StateConflictError("The rejected restaurant cannot win the re-drop.");
      }

      return save({
        ...state,
        winners: { ...state.winners, [state.date]: name },
      });
    }),

    recordRedrop: (rejected) => run(async () => {
      const name = winnerName(rejected, "rejected");
      const state = await load();
      if (state.redropUsed) {
        if (state.rejectedToday === name) return cloneState(state);
        throw new StateConflictError("The re-drop was already used for this date.");
      }

      const accepted = state.winners[state.date];
      if (accepted !== undefined && accepted !== name) {
        throw new StateConflictError("The re-drop must reject today's accepted winner.");
      }

      return save({ ...state, rejectedToday: name, redropUsed: true });
    }),

    resetWeek: () => run(async () => {
      const state = await load();
      const reset = freshState({ week: state.week, date: state.date });
      if (sameState(state, reset)) return cloneState(state);
      return save(reset);
    }),
  };
}
