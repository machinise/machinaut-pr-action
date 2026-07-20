import { describe, expect, it } from "vitest"
import {
  deriveChips,
  deriveSessionStatus,
  fmtDuration,
  type ProjectedAction,
  sessionWall,
  type WireProjection,
} from "../projection"

const action = (phase?: string, result?: string): ProjectedAction => ({
  terminal_phase: phase,
  outcome: result === undefined ? null : { result },
})

describe("deriveSessionStatus — parity with the console's session page", () => {
  it("returns 'No actions' when the chain governed nothing", () => {
    expect(deriveSessionStatus({ actions: [] }).label).toBe("No actions")
    expect(deriveSessionStatus({}).label).toBe("No actions")
  })

  it("Blocked wins over everything (a denied/blocked/rejected phase)", () => {
    expect(deriveSessionStatus({ actions: [action("blocked"), action("executed", "success")] }).label).toBe("Blocked")
    expect(deriveSessionStatus({ actions: [action("rejected")] }).label).toBe("Blocked")
  })

  it("Held for a pending/awaiting-approval phase", () => {
    expect(deriveSessionStatus({ actions: [action("pending_approval")] }).label).toBe("Held")
    expect(deriveSessionStatus({ actions: [action("awaiting")] }).label).toBe("Held")
  })

  it("Failed on a failure outcome", () => {
    expect(deriveSessionStatus({ actions: [action("completed", "failure")] }).label).toBe("Failed")
  })

  it("Partial on a partial outcome even when the phase reads executed", () => {
    expect(deriveSessionStatus({ actions: [action("executed", "partial")] }).label).toBe("Partial")
  })

  it("Executed only when every action executed/succeeded", () => {
    expect(
      deriveSessionStatus({ actions: [action("executed", "success"), action("completed", "success")] }).label,
    ).toBe("Executed")
  })

  it("Proposed when actions exist but none reached an outcome", () => {
    expect(deriveSessionStatus({ actions: [action("proposed")] }).label).toBe("Proposed")
  })
})

describe("wall clock", () => {
  it("formats sub-second, sub-10s, and minute spans", () => {
    expect(fmtDuration(420)).toBe("420 ms")
    expect(fmtDuration(4200)).toBe("4.2s")
    expect(fmtDuration(63_000)).toBe("1m 03s")
    // 119.6s must round to 2m 00s, never 1m 60s.
    expect(fmtDuration(119_600)).toBe("2m 00s")
  })

  it("sessionWall spans first→last event, undefined when a timestamp is missing", () => {
    expect(
      sessionWall({ first_event_at: "2026-07-19T00:00:00Z", last_event_at: "2026-07-19T00:00:04.2Z" }),
    ).toBe("4.2s")
    expect(sessionWall({ first_event_at: "2026-07-19T00:00:00Z" })).toBeUndefined()
  })
})

describe("deriveChips", () => {
  it("counts events and agents and carries the verdict + wall", () => {
    const p: WireProjection = {
      event_count: 13,
      actor_ids: ["a", "b", "c", "d", "e"],
      first_event_at: "2026-07-19T00:00:00Z",
      last_event_at: "2026-07-19T00:00:04.2Z",
      actions: [action("executed", "success")],
    }
    expect(deriveChips(p)).toEqual({ events: 13, agents: 5, verdict: "Executed", wall: "4.2s" })
  })

  it("defaults to zeros for an empty projection", () => {
    expect(deriveChips({})).toEqual({ events: 0, agents: 0, verdict: "No actions", wall: undefined })
  })
})
