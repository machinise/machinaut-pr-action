import { createHash } from "node:crypto"
// The toolkit's own Statement builder — used to prove our statement file is
// byte-identical to what `attest()` signs. Test-only deep import.
import { buildIntotoStatement } from "@actions/attest/lib/intoto"
import { describe, expect, it } from "vitest"
import { parseGovernanceSummary } from "../governance"
import {
  assertPredicatePrivacy,
  buildStatement,
  canonicalJson,
  PREDICATE_TYPE,
  PredicatePrivacyError,
  STATEMENT_TYPE,
  SUMMARY_SUBJECT_NAME,
  type StatementInput,
  summaryDocument,
} from "../statement"
import { ACTION_REF } from "../version"
import { EXPECTED, HEAD_SHA, rawSummary, summary } from "./fixtures/summary"

const POLICY = { require_holds_resolved: true, require_bound_approvals: false, max_sentinel_severity: "warning" as const, allow_unreadable: false }

function input(overrides: Partial<StatementInput> = {}): StatementInput {
  return { owner: "acme", repo: "widgets", headSha: HEAD_SHA, summary: summary(), policy: POLICY, decision: "pass", reasons: [], ...overrides }
}

describe("buildStatement — in-toto Statement v1, governed-run/v1 predicate", () => {
  it("has the plan §2.2 envelope: type, PR-head subject, predicate type", () => {
    const st = buildStatement(input())
    expect(st._type).toBe(STATEMENT_TYPE)
    expect(st._type).toBe("https://in-toto.io/Statement/v1")
    expect(st.predicateType).toBe("https://machinaut.ai/attestation/governed-run/v1")
    expect(st.predicateType).toBe(PREDICATE_TYPE)
    expect(st.subject[0]).toEqual({ name: "acme/widgets", digest: { gitCommit: HEAD_SHA } })
  })

  it("records the invocation facts GitHub provides, and omits them when absent", () => {
    const withRef = buildStatement(
      input({ actionInvocation: { ref: "49dcb11aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", repository: "machinise/machinaut-pr-action" } }),
    )
    expect(withRef.predicate.gate.action).toBe(ACTION_REF)
    expect(withRef.predicate.gate.action_ref).toBe("49dcb11aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    expect(withRef.predicate.gate.action_repository).toBe("machinise/machinaut-pr-action")
    const bare = buildStatement(input())
    expect("action_ref" in bare.predicate.gate).toBe(false)
    expect("action_repository" in bare.predicate.gate).toBe(false)
  })

  it("adds the evaluated summary as a sha256 subject so `gh attestation verify <file>` can find and match it", () => {
    const st = buildStatement(input())
    const expectedHex = createHash("sha256").update(summaryDocument(summary())).digest("hex")
    expect(st.subject).toHaveLength(2)
    expect(st.subject[1]).toEqual({ name: SUMMARY_SUBJECT_NAME, digest: { sha256: expectedHex } })
  })

  it("predicate = the summary verbatim + the gate block the ACTION wrote", () => {
    const st = buildStatement(input({ decision: "fail", reasons: ["1 critical sentinel fired"] }))
    const { gate, ...facts } = st.predicate
    expect(facts).toEqual(summary())
    expect(gate).toEqual({ action: ACTION_REF, policy: POLICY, decision: "fail", reasons: ["1 critical sentinel fired"] })
    expect(gate.action).toMatch(/^machinise\/machinaut-pr-action@v\d+\.\d+\.\d+/)
    expect(Object.keys(st.predicate)).toEqual([
      "machinaut",
      "chain",
      "holds",
      "holds_truncated",
      "sentinels",
      "unreadable",
      "gate",
    ])
    // the G0 facts beyond §2.2 are carried verbatim (they are counts, not payloads)
    expect(st.predicate.holds_truncated).toBe(false)
    expect(st.predicate.unreadable).toEqual({ approval_requests: 0, sentinel_alerts: 0 })
    expect(st.predicate).not.toHaveProperty("beta")
  })

  it("is deterministic: same input → same bytes, regardless of the API's key order", () => {
    const a = JSON.stringify(buildStatement(input()))
    const b = JSON.stringify(buildStatement(input()))
    expect(a).toBe(b)

    // Same facts, keys shuffled at every level, as a different server might send them.
    const shuffled = JSON.parse(JSON.stringify(rawSummary(), (_k, v) =>
      v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v,
    ))
    const parsed = parseGovernanceSummary(shuffled, EXPECTED).summary
    expect(JSON.stringify(buildStatement(input({ summary: parsed })))).toBe(a)
  })

  it("serialises byte-identically to the toolkit's own buildIntotoStatement (what attest() signs)", () => {
    const st = buildStatement(input())
    const toolkit = buildIntotoStatement(st.subject, { type: st.predicateType, params: st.predicate })
    expect(JSON.stringify(toolkit)).toBe(JSON.stringify(st))
  })

  it("canonical summary document is sorted, compact, and reproducible with `jq -cjS`", () => {
    const doc = summaryDocument(summary())
    expect(doc).not.toMatch(/\n|": /)
    expect(doc.startsWith('{"chain":{"chain_digest":')).toBe(true)
    // canonicalJson is insensitive to key order and preserves array order
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}')
  })
})

describe("statement privacy — the predicate lands in a public transparency log", () => {
  const FORBIDDEN = ["payload", "prompt", "reason", "approver", "actor", "name", "inputs", "report_markdown", "raw_events"]

  /** Collect every key in the predicate (recursively). */
  function keys(v: unknown, out: string[] = []): string[] {
    if (Array.isArray(v)) v.forEach((x) => keys(x, out))
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        out.push(k)
        keys(x, out)
      }
    return out
  }

  it("carries no payload / prompt / reason-text / actor-name fields, even when the API sends them", () => {
    const raw = rawSummary()
    raw.holds[0].reason = "LGTM ship it — Ada"
    raw.holds[0].approver_id = "ada@example.com"
    raw.holds[0].actor_name = "Ada Lovelace"
    raw.chain.payload = { prompt: "do the thing" }
    raw.inputs = { secret: "x" }
    const parsed = parseGovernanceSummary(raw, EXPECTED).summary
    const st = buildStatement(input({ summary: parsed }))
    const predicateKeys = keys(st.predicate)
    for (const k of predicateKeys) {
      // `reasons` (the gate's own, ids/counts only) is the one allowed near-miss.
      if (k === "reasons") continue
      for (const f of FORBIDDEN) expect(k.includes(f), `predicate key '${k}' looks like '${f}'`).toBe(false)
    }
    const json = JSON.stringify(st)
    for (const leaked of ["LGTM", "ada@example.com", "Ada Lovelace", "do the thing", "secret"]) {
      expect(json).not.toContain(leaked)
    }
  })

  it("refuses to build a statement whose predicate grew an unknown field", () => {
    const s = summary() as any
    s.holds[0].reason = "approved"
    expect(() => buildStatement(input({ summary: s }))).toThrow(PredicatePrivacyError)
    expect(() => assertPredicatePrivacy({ machinaut: { prompt: "x" } })).toThrow(/predicate\.machinaut\.prompt/)
  })
})
