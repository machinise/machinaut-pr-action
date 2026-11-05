import { describe, expect, it, vi } from "vitest"
import { fetchGovernanceSummary, GovernanceSchemaError, parseGovernanceSummary, SUMMARY_VERSION } from "../governance"
import { MachinautApiError } from "../machinaut"
import { EXPECTED, rawSummary, summary as parsedFixture } from "./fixtures/summary"

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("parseGovernanceSummary", () => {
  it("accepts G0's governance_summary@1 body and projects it onto the frozen shape", () => {
    const { summary, dropped } = parseGovernanceSummary(rawSummary(), EXPECTED)
    expect(dropped).toEqual([]) // `beta` is G0's candor label: ignored, silently
    expect(summary).toEqual(parsedFixture())
    expect(summary).not.toHaveProperty("beta")
    expect(summary.machinaut.summary_version).toBe(SUMMARY_VERSION)
    expect(summary.holds_truncated).toBe(false)
    expect(summary.unreadable).toEqual({ approval_requests: 0, sentinel_alerts: 0 })
  })

  it("requires holds_truncated and unreadable — the gate fails closed on what it cannot see", () => {
    const a = rawSummary()
    delete a.holds_truncated
    expect(() => parseGovernanceSummary(a, EXPECTED)).toThrow(/holds_truncated must be a boolean/)
    const b = rawSummary()
    delete b.unreadable
    expect(() => parseGovernanceSummary(b, EXPECTED)).toThrow(/unreadable must be an object/)
    const c = rawSummary()
    c.unreadable.sentinel_alerts = "some"
    expect(() => parseGovernanceSummary(c, EXPECTED)).toThrow(/unreadable.sentinel_alerts must be a non-negative integer/)
  })

  it("rejects any other summary_version with a clear, actionable error", () => {
    const raw = rawSummary()
    raw.machinaut.summary_version = "governance_summary@2"
    expect(() => parseGovernanceSummary(raw, EXPECTED)).toThrow(GovernanceSchemaError)
    expect(() => parseGovernanceSummary(raw, EXPECTED)).toThrow(
      /unsupported governance summary version "governance_summary@2".*understands only 'governance_summary@1'/,
    )
  })

  it("rejects a body with no summary_version at all", () => {
    const raw = rawSummary()
    delete raw.machinaut.summary_version
    expect(() => parseGovernanceSummary(raw, EXPECTED)).toThrow(/unsupported governance summary version null/)
  })

  it("rejects a summary for a different project or session than the run asked for", () => {
    expect(() => parseGovernanceSummary(rawSummary(), { projectId: "demo", sessionId: "other" })).toThrow(
      /is for demo\/sess-demo, but this run asked for demo\/other/,
    )
  })

  it("drops (and reports) fields outside the schema — they never reach the public predicate", () => {
    const raw = rawSummary()
    raw.gate = { decision: "pass" } // Machinaut must never write a verdict
    raw.payload = { prompt: "secret prompt" }
    raw.holds[0].reason = "approved because the deploy looked fine"
    raw.holds[0].approver_name = "Ada Lovelace"
    raw.chain.raw_events = [{ payload: "x" }]
    const { summary, dropped } = parseGovernanceSummary(raw, EXPECTED)
    expect(dropped.sort()).toEqual(
      ["chain.raw_events", "gate", "holds[0].approver_name", "holds[0].reason", "payload"].sort(),
    )
    const json = JSON.stringify(summary)
    for (const leaked of ["secret prompt", "approved because", "Ada Lovelace", "raw_events", '"gate"']) {
      expect(json).not.toContain(leaked)
    }
  })

  it("accepts Lodestar's bare-hex ADR-0042 hash as well as the sha256:-prefixed form", () => {
    const raw = rawSummary()
    raw.holds[0].action_representation_hash = "a".repeat(64)
    expect(parseGovernanceSummary(raw, EXPECTED).summary.holds[0]!.action_representation_hash).toBe("a".repeat(64))
  })

  it("treats null optional fields as absent", () => {
    const raw = rawSummary()
    raw.holds[1].action_representation_hash = null
    raw.holds[1].quorum = null
    const hold = parseGovernanceSummary(raw, EXPECTED).summary.holds[1]!
    expect(hold).toEqual({ request_id: "req-drop-table-2", outcome: "denied", evidence: "host_record" })
  })

  it.each([
    ["chain.chain_digest", (r: any) => (r.chain.chain_digest = "sha256:not-a-digest"), /chain_digest must be a sha256 digest/],
    ["holds[].outcome", (r: any) => (r.holds[0].outcome = "approved"), /outcome must be one of granted/],
    ["holds[].evidence", (r: any) => (r.holds[0].evidence = "trust_me"), /evidence must be one of host_record/],
    ["sentinels.critical", (r: any) => (r.sentinels.critical = -1), /sentinels.critical must be a non-negative integer/],
    ["chain.events", (r: any) => (r.chain.events = 1.5), /chain.events must be a non-negative integer/],
    ["holds", (r: any) => (r.holds = {}), /holds must be an array/],
    ["request_id", (r: any) => (r.holds[0].request_id = "has space"), /request_id must be an id/],
    ["as_of", (r: any) => (r.machinaut.as_of = "yesterday"), /as_of must be an ISO-8601 timestamp/],
    ["console", (r: any) => (r.machinaut.console = "javascript:alert(1)"), /console must be an absolute http\(s\) URL/],
    ["quorum.record_digest", (r: any) => (r.holds[0].quorum.record_digest = "x"), /record_digest must be a sha256 digest/],
  ])("rejects a malformed %s", (_name, mutate, message) => {
    const raw = rawSummary()
    mutate(raw)
    expect(() => parseGovernanceSummary(raw, EXPECTED)).toThrow(message)
  })

  it("rejects a non-object body", () => {
    expect(() => parseGovernanceSummary(null, EXPECTED)).toThrow(/response body must be an object/)
    expect(() => parseGovernanceSummary([], EXPECTED)).toThrow(/response body must be an object/)
  })
})

describe("fetchGovernanceSummary", () => {
  const opts = { apiUrl: "https://console.machinaut.ai/", apiKey: "sk_test", projectId: "demo", sessionId: "sess-demo" }

  it("GETs …/sessions/:s/governance with the project key (read-only)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, rawSummary()))
    const { summary } = await fetchGovernanceSummary(opts, { fetch: fetchMock as unknown as typeof fetch })
    expect(summary.chain.events).toBe(143)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://console.machinaut.ai/v1/projects/demo/sessions/sess-demo/governance")
    expect(init.method).toBe("GET")
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk_test")
  })

  it("percent-encodes path segments", async () => {
    const raw = rawSummary()
    raw.machinaut.project_id = "a/b"
    raw.machinaut.session_id = "s?d"
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, raw))
    await fetchGovernanceSummary(
      { ...opts, projectId: "a/b", sessionId: "s?d" },
      { fetch: fetchMock as unknown as typeof fetch },
    )
    expect(fetchMock.mock.calls[0]![0]).toBe("https://console.machinaut.ai/v1/projects/a%2Fb/sessions/s%3Fd/governance")
  })

  it("turns a 404 into an error that says what to check (never a skip)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(404, { error: "not_found" }))
    const err = await fetchGovernanceSummary(opts, { fetch: fetchMock as unknown as typeof fetch }).catch((e) => e)
    expect(err).toBeInstanceOf(MachinautApiError)
    expect(err.status).toBe(404)
    expect(err.message).toMatch(/No governance summary for session 'sess-demo'.*serves GET …\/sessions\/:s\/governance/)
  })

  it("surfaces a schema error from a 200 with the wrong version", async () => {
    const raw = rawSummary()
    raw.machinaut.summary_version = "governance_summary@0"
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, raw))
    await expect(fetchGovernanceSummary(opts, { fetch: fetchMock as unknown as typeof fetch })).rejects.toBeInstanceOf(
      GovernanceSchemaError,
    )
  })
})
