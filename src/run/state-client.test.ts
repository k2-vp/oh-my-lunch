import { describe, expect, it } from "vitest";
import {
  fetchWeekState,
  postAcceptedWinner,
  postRejection,
  todaysWinner,
  weeklyWinnerNames,
  type FetchLike,
  type WeekState,
} from "./state-client.ts";

const SAMPLE: WeekState = {
  week: "2026-W35",
  date: "2026-08-26",
  winners: { "2026-08-25": "Taco Cantina", "2026-08-26": "Daily Bread" },
  rejectedToday: null,
  redropUsed: false,
};

interface Call {
  readonly input: string;
  readonly init?: RequestInit | undefined;
}

function recordingFetch(state: WeekState = SAMPLE, status = 200): {
  fetchLike: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchLike: FetchLike = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(
      new Response(JSON.stringify(state), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetchLike, calls };
}

function sentBody(call: Call | undefined): unknown {
  return JSON.parse(String(call?.init?.body));
}

describe("state client", () => {
  it("reads the week state from GET /api/state", async () => {
    const { fetchLike, calls } = recordingFetch();
    const state = await fetchWeekState(fetchLike);

    expect(calls[0]?.input).toBe("/api/state");
    expect(calls[0]?.init).toBeUndefined();
    expect(state.week).toBe("2026-W35");
    expect(state.redropUsed).toBe(false);
  });

  it("posts an accepted winner without completesRedrop by default", async () => {
    const { fetchLike, calls } = recordingFetch();
    await postAcceptedWinner("Taco Cantina", false, fetchLike);

    expect(calls[0]?.input).toBe("/api/state/accept");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(sentBody(calls[0])).toEqual({ winner: "Taco Cantina" });
  });

  it("posts an accepted winner with completesRedrop after a re-drop", async () => {
    const { fetchLike, calls } = recordingFetch();
    await postAcceptedWinner("Daily Bread", true, fetchLike);

    expect(sentBody(calls[0])).toEqual({ winner: "Daily Bread", completesRedrop: true });
  });

  it("posts the rejection to the re-drop endpoint", async () => {
    const { fetchLike, calls } = recordingFetch();
    await postRejection("Taco Cantina", fetchLike);

    expect(calls[0]?.input).toBe("/api/state/redrop");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(sentBody(calls[0])).toEqual({ rejected: "Taco Cantina" });
  });

  it("throws when the server rejects a write", async () => {
    const { fetchLike } = recordingFetch(SAMPLE, 409);
    await expect(postAcceptedWinner("Taco Cantina", false, fetchLike)).rejects.toThrow(/409/);
  });

  it("derives the spent names and today's winner", () => {
    expect(weeklyWinnerNames(SAMPLE).sort()).toEqual(["Daily Bread", "Taco Cantina"]);
    expect(todaysWinner(SAMPLE)).toBe("Daily Bread");
    expect(todaysWinner({ ...SAMPLE, winners: { "2026-08-25": "Taco Cantina" } })).toBeNull();
  });
});
