import { ConfigError, RepositoryError, RequestError } from "@repo-arch/shared";
import { describe, expect, it } from "vitest";
import {
  AnalysisEventBus,
  PHASE_MESSAGES,
  canTransition,
  logFailureMessage,
  safeFailureMessage,
  type AnalysisEvent,
} from "../src/lifecycle";
import { ANALYSIS_PHASES, ANALYSIS_STATUSES, isTerminal, type AnalysisStatus } from "../src/store/types";

/**
 * Progress reporting, and the two things it must not become.
 *
 * The event bus is the only path from a running analysis to a browser, so the
 * tests here are about its boundaries rather than its plumbing: that a late
 * subscriber sees the same sequence as an early one (or the UI would routinely
 * miss the first two events), that neither buffer can grow without limit, and
 * that a dead socket cannot take the analysis down with it.
 *
 * `safeFailureMessage` gets the same treatment from the other direction. It is the
 * one function standing between an arbitrary thrown exception and a browser, and
 * the failure mode it exists to prevent — a filesystem path or a SQL fragment
 * rendered as an explanation — is asserted directly.
 */

function phase(analysisId: string, at: string): AnalysisEvent {
  return { type: "analysis.phase", analysisId, at, phase: "scouting", message: PHASE_MESSAGES.scouting };
}

describe("AnalysisEventBus", () => {
  it("delivers to every current subscriber", () => {
    const bus = new AnalysisEventBus();
    const first: AnalysisEvent[] = [];
    const second: AnalysisEvent[] = [];

    bus.subscribe("an-1", (event) => first.push(event));
    bus.subscribe("an-1", (event) => second.push(event));
    bus.emit(phase("an-1", "t0"));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(bus.subscriberCount("an-1")).toBe(2);
  });

  it("replays to a late subscriber, so it sees the same sequence as an early one", () => {
    const bus = new AnalysisEventBus();
    const early: AnalysisEvent[] = [];
    bus.subscribe("an-1", (event) => early.push(event));

    bus.emit({ type: "analysis.created", analysisId: "an-1", at: "t0", repositoryPath: "widget", status: "queued" });
    bus.emit({ type: "analysis.started", analysisId: "an-1", at: "t1", status: "validating" });

    // A browser that POSTs an analysis and then opens the stream is always a round
    // trip late. Without replay it would reliably miss both of the above.
    const late: AnalysisEvent[] = [];
    bus.subscribe("an-1", (event) => late.push(event));

    expect(late.map((event) => event.type)).toEqual(early.map((event) => event.type));
    expect(late.map((event) => event.type)).toEqual(["analysis.created", "analysis.started"]);
  });

  it("keeps one analysis's events out of another's stream", () => {
    const bus = new AnalysisEventBus();
    const seen: AnalysisEvent[] = [];
    bus.subscribe("an-1", (event) => seen.push(event));

    bus.emit(phase("an-2", "t0"));

    expect(seen).toEqual([]);
    expect(bus.replay("an-1")).toEqual([]);
  });

  it("stops delivering after unsubscribe, and only to the caller's own listener", () => {
    const bus = new AnalysisEventBus();
    const kept: AnalysisEvent[] = [];
    const dropped: AnalysisEvent[] = [];

    bus.subscribe("an-1", (event) => kept.push(event));
    const unsubscribe = bus.subscribe("an-1", (event) => dropped.push(event));
    unsubscribe();
    bus.emit(phase("an-1", "t0"));

    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
    expect(bus.subscriberCount("an-1")).toBe(1);
  });

  it("survives a subscriber that throws, and still reaches the others", () => {
    const bus = new AnalysisEventBus();
    const survived: AnalysisEvent[] = [];

    bus.subscribe("an-1", () => {
      throw new Error("socket closed");
    });
    bus.subscribe("an-1", (event) => survived.push(event));

    // A browser whose socket died must not be able to fail the analysis.
    expect(() => bus.emit(phase("an-1", "t0"))).not.toThrow();
    expect(survived).toHaveLength(1);
  });

  it("bounds the replay buffer per analysis, keeping the newest", () => {
    const bus = new AnalysisEventBus(3, 8);
    for (let index = 0; index < 6; index += 1) bus.emit(phase("an-1", `t${index}`));

    const replayed = bus.replay("an-1");
    expect(replayed).toHaveLength(3);
    // This is a live-progress buffer, not a record. The record is the database, so
    // when it has to drop something it drops the oldest.
    expect(replayed.map((event) => event.at)).toEqual(["t3", "t4", "t5"]);
  });

  it("bounds how many analyses it buffers at all", () => {
    const bus = new AnalysisEventBus(8, 2);
    bus.emit(phase("an-1", "t0"));
    bus.emit(phase("an-2", "t0"));
    bus.emit(phase("an-3", "t0"));

    // Oldest evicted. Without this a long-lived server accumulates a buffer per
    // analysis it ever ran.
    expect(bus.replay("an-1")).toEqual([]);
    expect(bus.replay("an-3")).toHaveLength(1);
  });

  it("forgets an analysis's events and listeners on request", () => {
    const bus = new AnalysisEventBus();
    bus.subscribe("an-1", () => {});
    bus.emit(phase("an-1", "t0"));

    bus.forget("an-1");

    // Called after a delete: an id that no longer exists has no progress.
    expect(bus.replay("an-1")).toEqual([]);
    expect(bus.subscriberCount("an-1")).toBe(0);
  });
});

describe("PHASE_MESSAGES", () => {
  it("has one line of prose for every phase the product can observe", () => {
    // The browser shows these verbatim, so a missing one would render `undefined`.
    for (const name of ANALYSIS_PHASES) {
      expect(PHASE_MESSAGES[name]).toBeTypeOf("string");
      expect(PHASE_MESSAGES[name].length).toBeGreaterThan(0);
    }
    expect(Object.keys(PHASE_MESSAGES).sort()).toEqual([...ANALYSIS_PHASES].sort());
  });
});

describe("canTransition", () => {
  it("allows exactly the forward moves the lifecycle defines", () => {
    expect(canTransition("queued", "validating")).toBe(true);
    expect(canTransition("validating", "analyzing")).toBe(true);
    expect(canTransition("analyzing", "completed")).toBe(true);
  });

  it("lets any non-terminal status fail", () => {
    expect(canTransition("queued", "failed")).toBe(true);
    expect(canTransition("validating", "failed")).toBe(true);
    expect(canTransition("analyzing", "failed")).toBe(true);
  });

  it("refuses to move out of a terminal status", () => {
    const terminal: AnalysisStatus[] = ["completed", "failed"];
    for (const from of terminal) {
      for (const to of ANALYSIS_STATUSES) {
        // A finished analysis is finished. Reopening one would make the status a
        // guess rather than a promise about what the record contains.
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it("refuses to skip a state or to go backwards", () => {
    expect(canTransition("queued", "analyzing")).toBe(false);
    expect(canTransition("queued", "completed")).toBe(false);
    expect(canTransition("validating", "completed")).toBe(false);
    expect(canTransition("analyzing", "validating")).toBe(false);
    expect(canTransition("queued", "queued")).toBe(false);
  });

  it("agrees with isTerminal about which statuses are ends", () => {
    for (const status of ANALYSIS_STATUSES) {
      const hasSuccessor = ANALYSIS_STATUSES.some((next) => canTransition(status, next));
      expect(isTerminal(status)).toBe(!hasSuccessor);
    }
  });
});

describe("safeFailureMessage", () => {
  it("passes our own errors through, because they were written to be read", () => {
    const message = safeFailureMessage(new RepositoryError("widget/src is not inside the workspace."));
    expect(message).toBe("widget/src is not inside the workspace.");
  });

  it("replaces an unanticipated exception wholesale rather than filtering it", () => {
    const message = safeFailureMessage(new Error("ENOENT: no such file or directory, open '/home/someone/.ssh/id_rsa'"));

    // The category decides. An exception we did not anticipate carries a path, a SQL
    // fragment or a stack frame at least as often as it carries an explanation.
    expect(message).toBe("The analysis failed. See the server log for details.");
    expect(message).not.toContain("id_rsa");
  });

  it("replaces a non-Error throw too", () => {
    expect(safeFailureMessage("something went wrong at /srv/secrets")).not.toContain("/srv/secrets");
    expect(safeFailureMessage(undefined)).toBe("The analysis failed. See the server log for details.");
  });

  it("redacts a credential even out of our own error's message", () => {
    const message = safeFailureMessage(new ConfigError('GEMINI_API_KEY="AIzaSyDEADBEEFdeadbeef1234567890xx" was rejected'));
    expect(message).not.toContain("AIzaSyDEADBEEFdeadbeef1234567890xx");
    expect(message).toContain("<redacted");
  });

  it("drops the hint, which was written for an operator", () => {
    const message = safeFailureMessage(
      new RequestError("No such analysis.", "Look in /home/someone/.repo-archaeologist/analyses.db."),
    );

    expect(message).toBe("No such analysis.");
    expect(message).not.toContain("analyses.db");
  });
});

describe("logFailureMessage", () => {
  it("keeps the detail an operator needs", () => {
    const logged = logFailureMessage(new RepositoryError("not a repository", "Pass --root."));
    // The pair is the point: this one is for stderr, the other is for a browser.
    expect(logged).toContain("not a repository");
    expect(logged).toContain("Pass --root.");
  });

  it("still redacts a credential on its way to the log", () => {
    const logged = logFailureMessage(new Error("call failed with key AIzaSyDEADBEEFdeadbeef1234567890xx"));
    expect(logged).not.toContain("AIzaSyDEADBEEFdeadbeef1234567890xx");
  });
});
