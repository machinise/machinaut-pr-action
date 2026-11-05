import { describe, expect, it } from "vitest"
import { evaluateGate, MAX_HOLD_REASONS, predicatePolicy } from "../gate"
import type { Hold } from "../governance"
import type { GatePolicy } from "../inputs"
import { summary } from "./fixtures/summary"

/** Plan D5 defaults. */
const DEFAULT_POLICY: GatePolicy = { requireHoldsResolved: true, requireBoundApprovals: false, maxSentinelSeverity: "warning", allowUnreadable: false }

describe("evaluateGate — plan D5 defaults", () => {
  it("passes the fixture: holds resolved by host records, no critical sentinel", () => {
    expect(evaluateGate(summary(), DEFAULT_POLICY)).toEqual({ decision: "pass", reasons: [], failures: [], notes: [] })
  })

  it("fails on a critical sentinel", () => {
    const s = summary()
    s.sentinels.critical = 1
    const r = evaluateGate(s, DEFAULT_POLICY)
    expect(r.decision).toBe("fail")
    expect(r.reasons).toEqual(["1 critical sentinel fired (max-sentinel-severity is warning)"])
  })

  it("fails on a relay_only hold — a relayed resolution is not a verified approval", () => {
    const s = summary()
    s.holds[0]!.evidence = "relay_only"
    const r = evaluateGate(s, DEFAULT_POLICY)
    expect(r.decision).toBe("fail")
    expect(r.reasons).toEqual([
      "hold req-deploy-1: granted, evidence relay_only — a relayed resolution with no host record is not a verified approval",
    ])
  })

  it("passes with a relay_only hold when require-holds-resolved is false", () => {
    const s = summary()
    s.holds[0]!.evidence = "relay_only"
    s.holds.push({ request_id: "req-3", outcome: "unresolved", evidence: "unavailable" })
    expect(evaluateGate(s, { ...DEFAULT_POLICY, requireHoldsResolved: false })).toMatchObject({ decision: "pass", reasons: [] })
  })

  it.each([
    ["unavailable evidence", { outcome: "granted", evidence: "unavailable" }, /evidence unavailable — the host record could not be loaded/],
    ["an expired hold", { outcome: "expired", evidence: "host_record" }, /expired, evidence host_record — not granted or denied/],
    ["an unresolved hold", { outcome: "unresolved", evidence: "host_record" }, /unresolved, evidence host_record/],
  ] as const)("fails on %s", (_name, fields, reason) => {
    const s = summary()
    s.holds.push({ request_id: "req-x", ...fields } as Hold)
    const r = evaluateGate(s, DEFAULT_POLICY)
    expect(r.decision).toBe("fail")
    expect(r.reasons).toHaveLength(1)
    expect(r.reasons[0]).toMatch(reason)
  })

  it("counts a denied hold with a host record as resolved", () => {
    const s = summary()
    s.holds = [{ request_id: "r", outcome: "denied", evidence: "host_record" }]
    expect(evaluateGate(s, DEFAULT_POLICY).decision).toBe("pass")
  })

  it("passes a session with no holds", () => {
    const s = summary()
    s.holds = []
    expect(evaluateGate(s, DEFAULT_POLICY).decision).toBe("pass")
  })
})

describe("evaluateGate — require-bound-approvals", () => {
  const unboundGrant = (): ReturnType<typeof summary> => {
    const s = summary()
    s.holds.push({ request_id: "req-unbound", outcome: "granted", evidence: "host_record" })
    return s
  }

  it("is off by default: an unbound grant passes", () => {
    expect(evaluateGate(unboundGrant(), DEFAULT_POLICY).decision).toBe("pass")
  })

  it("when on, fails every granted hold without an action_representation_hash", () => {
    const r = evaluateGate(unboundGrant(), { ...DEFAULT_POLICY, requireBoundApprovals: true })
    expect(r.decision).toBe("fail")
    expect(r.reasons).toEqual([
      "hold req-unbound: granted without an ADR-0042 action binding (no action_representation_hash; require-bound-approvals is true)",
    ])
  })

  it("when on, does not require a binding on denied holds", () => {
    // fixture hold 2 is denied and unbound; hold 1 is granted and bound
    expect(evaluateGate(summary(), { ...DEFAULT_POLICY, requireBoundApprovals: true }).decision).toBe("pass")
  })
})

describe("evaluateGate — max-sentinel-severity", () => {
  it("info: any warning fails (the fixture has one warning)", () => {
    const r = evaluateGate(summary(), { ...DEFAULT_POLICY, maxSentinelSeverity: "info" })
    expect(r.decision).toBe("fail")
    expect(r.reasons).toEqual(["1 warning sentinel fired (max-sentinel-severity is info)"])
  })

  it("info: warning and critical both reported", () => {
    const s = summary()
    s.sentinels = { info: 9, warning: 2, critical: 3 }
    expect(evaluateGate(s, { ...DEFAULT_POLICY, maxSentinelSeverity: "info" }).reasons).toEqual([
      "2 warning sentinels fired (max-sentinel-severity is info)",
      "3 critical sentinels fired (max-sentinel-severity is info)",
    ])
  })

  it("critical: sentinels never fail the gate", () => {
    const s = summary()
    s.sentinels = { info: 9, warning: 9, critical: 9 }
    expect(evaluateGate(s, { ...DEFAULT_POLICY, maxSentinelSeverity: "critical" }).decision).toBe("pass")
  })
})

describe("evaluateGate — bounded reasons", () => {
  it(`caps per-hold reasons at ${MAX_HOLD_REASONS} and summarises the rest`, () => {
    const s = summary()
    s.holds = Array.from({ length: MAX_HOLD_REASONS + 5 }, (_, i) => ({
      request_id: `r${i}`,
      outcome: "granted" as const,
      evidence: "relay_only" as const,
    }))
    const r = evaluateGate(s, DEFAULT_POLICY)
    expect(r.reasons).toHaveLength(MAX_HOLD_REASONS + 1)
    expect(r.reasons.at(-1)).toBe("…and 5 more hold(s) not resolved by a host record")
  })

  it("orders reasons deterministically: holds, bindings, sentinels", () => {
    const s = summary()
    s.holds = [{ request_id: "r", outcome: "granted", evidence: "relay_only" }]
    s.sentinels.critical = 1
    const r = evaluateGate(s, { ...DEFAULT_POLICY, requireBoundApprovals: true })
    expect(r.reasons.map((x) => x.split(" ")[0])).toEqual(["hold", "hold", "1"])
  })
})

describe("evaluateGate — truncated hold list (G0 caps holds[] at 50)", () => {
  const truncated = () => {
    const s = summary()
    s.holds_truncated = true
    return s
  }

  it("fails under require-holds-resolved", () => {
    const r = evaluateGate(truncated(), DEFAULT_POLICY)
    expect(r.decision).toBe("fail")
    expect(r.failures).toEqual(["hold list truncated; cannot evaluate every hold"])
  })

  it("fails under require-bound-approvals alone, too (every grant cannot be checked)", () => {
    const r = evaluateGate(truncated(), { ...DEFAULT_POLICY, requireHoldsResolved: false, requireBoundApprovals: true })
    expect(r.failures).toEqual(["hold list truncated; cannot evaluate every hold"])
  })

  it("is not downgraded by allow-unreadable", () => {
    expect(evaluateGate(truncated(), { ...DEFAULT_POLICY, allowUnreadable: true }).decision).toBe("fail")
  })

  it("does not matter when no hold rule is on", () => {
    expect(evaluateGate(truncated(), { ...DEFAULT_POLICY, requireHoldsResolved: false }).decision).toBe("pass")
  })
})

describe("evaluateGate — unreadable records fail CLOSED by default", () => {
  const withheld = (approval_requests: number, sentinel_alerts: number) => {
    const s = summary()
    s.unreadable = { approval_requests, sentinel_alerts }
    return s
  }

  it("unreadable approval requests fail the holds rule", () => {
    const r = evaluateGate(withheld(2, 0), DEFAULT_POLICY)
    expect(r.decision).toBe("fail")
    expect(r.failures).toEqual([
      "2 approval requests unreadable (withheld by the shipper below the secret ceiling); cannot evaluate every hold",
    ])
  })

  it("unreadable sentinel alerts fail the sentinel rule (a withheld critical would read as critical: 0)", () => {
    const r = evaluateGate(withheld(0, 1), DEFAULT_POLICY)
    expect(r.decision).toBe("fail")
    expect(r.failures).toEqual([
      "1 sentinel alert unreadable (withheld by the shipper below the secret ceiling); a withheld critical alert would read as critical: 0",
    ])
  })

  it("allow-unreadable downgrades both to stated notes that do not fail the gate", () => {
    const r = evaluateGate(withheld(3, 4), { ...DEFAULT_POLICY, allowUnreadable: true })
    expect(r.decision).toBe("pass")
    expect(r.failures).toEqual([])
    expect(r.notes).toEqual([
      "3 approval requests unreadable (withheld by the shipper below the secret ceiling) — not evaluated; allowed by allow-unreadable",
      "4 sentinel alerts unreadable (withheld by the shipper below the secret ceiling) — severity not evaluated; allowed by allow-unreadable",
    ])
    expect(r.reasons).toEqual(r.notes) // the statement still records what went unevaluated
  })

  it("allow-unreadable never masks a real failure", () => {
    const s = withheld(1, 1)
    s.sentinels.critical = 1
    const r = evaluateGate(s, { ...DEFAULT_POLICY, allowUnreadable: true })
    expect(r.decision).toBe("fail")
    expect(r.failures).toEqual(["1 critical sentinel fired (max-sentinel-severity is warning)"])
    expect(r.reasons).toHaveLength(3) // failure first, then the two notes
    expect(r.reasons[0]).toBe(r.failures[0])
  })

  it("unreadable approvals do not matter when no hold rule is on", () => {
    expect(evaluateGate(withheld(5, 0), { ...DEFAULT_POLICY, requireHoldsResolved: false }).decision).toBe("pass")
  })

  it("unreadable alerts do not matter when sentinels can never fail (max-sentinel-severity: critical)", () => {
    expect(evaluateGate(withheld(0, 5), { ...DEFAULT_POLICY, maxSentinelSeverity: "critical" }).decision).toBe("pass")
  })
})

describe("predicatePolicy", () => {
  it("records the policy with the §2.2 key names", () => {
    expect(predicatePolicy(DEFAULT_POLICY)).toEqual({
      require_holds_resolved: true,
      require_bound_approvals: false,
      max_sentinel_severity: "warning",
      allow_unreadable: false,
    })
  })
})
