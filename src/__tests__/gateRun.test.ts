import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { STICKY_MARKER } from "../comment"
import { GATE_STICKY_MARKER } from "../gateComment"
import { type GateContext, type GateDeps, type GateGitHubApi, runGate } from "../gateRun"
import type { Inputs } from "../inputs"
import type { StickyComment } from "../sticky"
import { HEAD_SHA, rawSummary } from "./fixtures/summary"

const OIDC = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t", RUNNER_TEMP: "/runner/tmp" }

function inputs(overrides: Partial<Inputs> = {}): Inputs {
  return {
    apiKey: "sk_test",
    projectId: "demo",
    sessionId: "sess-demo",
    apiUrl: "https://console.machinaut.ai",
    consoleUrl: "https://console.machinaut.ai",
    githubToken: "ghs_x",
    failOnError: true, // gate-mode default
    mode: "gate",
    policy: { requireHoldsResolved: true, requireBoundApprovals: false, maxSentinelSeverity: "warning", allowUnreadable: false },
    dryRun: false,
    ...overrides,
  }
}

function prContext(overrides: Partial<GateContext> = {}): GateContext {
  return {
    eventName: "pull_request",
    sha: "merge-commit-sha",
    payload: {
      pull_request: {
        number: 7,
        head: { sha: HEAD_SHA, repo: { full_name: "acme/widgets" } },
        base: { repo: { full_name: "acme/widgets" } },
      },
    },
    repo: { owner: "acme", repo: "widgets" },
    serverUrl: "https://github.com",
    ...overrides,
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

interface Harness {
  deps: GateDeps
  outputs: Record<string, string>
  core: { info: any; notice: any; warning: any; setOutput: any; setFailed: any }
  attest: ReturnType<typeof vi.fn>
  fetch: ReturnType<typeof vi.fn>
  files: Record<string, string>
  createComment: ReturnType<typeof vi.fn>
  updateComment: ReturnType<typeof vi.fn>
  request: ReturnType<typeof vi.fn>
  pullsGet: ReturnType<typeof vi.fn>
  lastBody: () => string
}

function harness(opts: {
  body?: unknown
  status?: number
  context?: GateContext
  env?: Record<string, string | undefined>
  attest?: ReturnType<typeof vi.fn>
  existingComments?: StickyComment[]
  createError?: Error
} = {}): Harness {
  const outputs: Record<string, string> = {}
  const core = {
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    setOutput: vi.fn((k: string, v: string) => (outputs[k] = v)),
    setFailed: vi.fn(),
  }
  // A fresh Response per call: a Response body can only be read once.
  const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(opts.status ?? 200, opts.body ?? rawSummary()))
  const attest =
    opts.attest ?? vi.fn().mockResolvedValue({ bundle: { mediaType: "sigstore-bundle" }, certificate: "pem", tlogID: "555" })
  const files: Record<string, string> = {}
  const createComment = vi.fn(async ({ body }: { body: string }) => {
    if (opts.createError) throw opts.createError
    return { data: { id: 99, html_url: "https://github.com/acme/widgets/pull/7#issuecomment-99", body } }
  })
  const updateComment = vi.fn(async ({ comment_id, body }: { comment_id: number; body: string }) => ({
    data: { id: comment_id, html_url: `https://github.com/acme/widgets/pull/7#issuecomment-${comment_id}`, body },
  }))
  const request = vi.fn().mockResolvedValue({ data: { id: 4242 } })
  const pullsGet = vi.fn().mockResolvedValue({ data: { head: { sha: HEAD_SHA } } })
  const octokit: GateGitHubApi = {
    paginate: vi.fn(async () => opts.existingComments ?? []) as GateGitHubApi["paginate"],
    request,
    rest: {
      issues: { listComments: {}, createComment, updateComment },
      repos: { listPullRequestsAssociatedWithCommit: {} },
      pulls: { get: pullsGet },
    },
  }
  const deps: GateDeps = {
    core,
    context: opts.context ?? prContext(),
    octokit: () => octokit,
    attest,
    env: opts.env ?? OIDC,
    fetch: fetchMock as unknown as typeof fetch,
    writeFile: async (p, d) => {
      files[p] = d
    },
    uniqueId: () => "run1",
  }
  const lastBody = () => {
    const calls = [...createComment.mock.calls, ...updateComment.mock.calls]
    return (calls.at(-1)?.[0] as { body: string } | undefined)?.body ?? ""
  }
  return { deps, outputs, core, attest, fetch: fetchMock, files, createComment, updateComment, request, pullsGet, lastBody }
}

describe("runGate — pass, signed", () => {
  it("fetches facts, decides pass, signs, stores, writes files and comments; the step passes", async () => {
    const h = harness()
    const out = await runGate(inputs(), h.deps)

    expect(out).toMatchObject({ decision: "pass", reasons: [], attestation: "signed", status: "created" })
    expect(h.core.setFailed).not.toHaveBeenCalled()
    expect(h.fetch.mock.calls[0]![0]).toBe("https://console.machinaut.ai/v1/projects/demo/sessions/sess-demo/governance")

    expect(h.outputs).toMatchObject({
      decision: "pass",
      reasons: "[]",
      attestation: "signed",
      "attestation-url": "https://github.com/acme/widgets/attestations/4242",
      "session-url": "https://console.machinaut.ai/projects/demo/sessions/sess-demo",
      status: "created",
    })

    // statement + summary + bundle written under RUNNER_TEMP, and the summary file
    // is exactly the sha256 subject `gh attestation verify` will check.
    const dir = "/runner/tmp/machinaut-governed-run/sess-demo-run1"
    expect(h.outputs["statement-path"]).toBe(`${dir}/governed-run.intoto.json`)
    expect(h.outputs["bundle-path"]).toBe(`${dir}/governed-run.sigstore.json`)
    const statement = JSON.parse(h.files[`${dir}/governed-run.intoto.json`]!)
    const summaryFile = h.files[h.outputs["summary-path"]!]!
    expect(statement.subject[1].digest.sha256).toBe(createHash("sha256").update(summaryFile).digest("hex"))
    expect(statement.subject[0]).toEqual({ name: "acme/widgets", digest: { gitCommit: HEAD_SHA } })
    expect(JSON.parse(h.files[`${dir}/governed-run.sigstore.json`]!)).toEqual({ mediaType: "sigstore-bundle" })

    // what was signed is the statement that was written
    const signed = h.attest.mock.calls[0]![0]
    expect({ _type: statement._type, subject: signed.subjects, predicateType: signed.predicateType, predicate: signed.predicate }).toEqual(statement)

    // the G2 intake seam makes no network call: one GET to Machinaut, nothing else
    expect(h.fetch).toHaveBeenCalledTimes(1)

    const body = h.lastBody()
    expect(body.startsWith(GATE_STICKY_MARKER)).toBe(true)
    expect(body).toContain("machinaut / governed-run: **pass**")
    expect(body).toContain("signed by this workflow via Sigstore")
    expect(body).toContain("https://github.com/acme/widgets/attestations/4242")
  })

  it("updates its own sticky comment in place and leaves comment mode's evidence comment alone", async () => {
    const h = harness({
      existingComments: [
        { id: 1, html_url: "u1", body: `${STICKY_MARKER}\nevidence comment` },
        { id: 2, html_url: "u2", body: `${GATE_STICKY_MARKER}\nold verdict` },
      ],
    })
    await runGate(inputs(), h.deps)
    expect(h.updateComment).toHaveBeenCalledTimes(1)
    expect(h.updateComment.mock.calls[0]![0]).toMatchObject({ comment_id: 2 })
    expect(h.outputs.status).toBe("updated")
  })
})

describe("runGate — evidence files", () => {
  it("gives every invocation its own directory, so a second gate step never overwrites the first's evidence", async () => {
    const h = harness()
    delete h.deps.uniqueId // real per-invocation ids
    await runGate(inputs(), h.deps)
    const first = { ...h.outputs }
    const firstStatement = h.files[first["statement-path"]!]
    await runGate(inputs({ policy: { ...inputs().policy, maxSentinelSeverity: "info" } }), h.deps)
    expect(h.outputs["statement-path"]).not.toBe(first["statement-path"])
    expect(h.outputs["bundle-path"]).not.toBe(first["bundle-path"])
    expect(h.files[first["statement-path"]!]).toBe(firstStatement)
    expect(JSON.parse(h.files[first["statement-path"]!]!).predicate.gate.decision).toBe("pass")
    expect(JSON.parse(h.files[h.outputs["statement-path"]!]!).predicate.gate.decision).toBe("fail")
  })
})

describe("runGate — decision fail", () => {
  it("fails the step on a critical sentinel even with fail-on-error false, and still signs the fail", async () => {
    const raw = rawSummary()
    raw.sentinels.critical = 2
    const h = harness({ body: raw })
    const out = await runGate(inputs({ failOnError: false }), h.deps)
    expect(out.decision).toBe("fail")
    expect(h.attest).toHaveBeenCalledOnce()
    expect(h.outputs.reasons).toBe(JSON.stringify(["2 critical sentinels fired (max-sentinel-severity is warning)"]))
    expect(h.core.setFailed).toHaveBeenCalledOnce()
    expect(h.core.setFailed.mock.calls[0]![0]).toMatch(/machinaut \/ governed-run: gate failed — 2 critical sentinels/)
    expect(h.lastBody()).toContain("machinaut / governed-run: **fail**")
    expect(h.lastBody()).toContain("**Why it failed:**")
  })

  it("fails on a relay_only hold under the default policy", async () => {
    const raw = rawSummary()
    raw.holds[0].evidence = "relay_only"
    const h = harness({ body: raw })
    const out = await runGate(inputs(), h.deps)
    expect(out.decision).toBe("fail")
    expect(h.core.setFailed).toHaveBeenCalledOnce()
  })

  it("passes the same relay_only hold when require-holds-resolved is false", async () => {
    const raw = rawSummary()
    raw.holds[0].evidence = "relay_only"
    const h = harness({ body: raw })
    const out = await runGate(inputs({ policy: { requireHoldsResolved: false, requireBoundApprovals: false, maxSentinelSeverity: "warning", allowUnreadable: false } }), h.deps)
    expect(out.decision).toBe("pass")
    expect(h.core.setFailed).not.toHaveBeenCalled()
  })
})

describe("runGate — what Machinaut cannot see fails closed", () => {
  it("a withheld sentinel alert fails the step by default", async () => {
    const raw = rawSummary()
    raw.unreadable.sentinel_alerts = 1
    const h = harness({ body: raw })
    const out = await runGate(inputs(), h.deps)
    expect(out.decision).toBe("fail")
    expect(h.core.setFailed.mock.calls[0]![0]).toMatch(/1 sentinel alert unreadable .*critical: 0/)
  })

  it("allow-unreadable: passes, but records and shows what went unevaluated", async () => {
    const raw = rawSummary()
    raw.unreadable = { approval_requests: 2, sentinel_alerts: 1 }
    const h = harness({ body: raw })
    const out = await runGate(inputs({ policy: { ...inputs().policy, allowUnreadable: true } }), h.deps)
    expect(out.decision).toBe("pass")
    expect(h.core.setFailed).not.toHaveBeenCalled()
    const reasons = JSON.parse(h.outputs.reasons!)
    expect(reasons).toHaveLength(2)
    expect(reasons.every((r: string) => r.includes("allowed by allow-unreadable"))).toBe(true)
    const signed = h.attest.mock.calls[0]![0]
    expect(signed.predicate.gate.reasons).toEqual(reasons)
    expect(signed.predicate.gate.policy.allow_unreadable).toBe(true)
    expect(signed.predicate.unreadable).toEqual({ approval_requests: 2, sentinel_alerts: 1 })
    expect(h.lastBody()).toContain("**Not evaluated (allowed by policy):**")
    expect(h.core.notice.mock.calls.flat().join("\n")).toMatch(/allowed by allow-unreadable/)
  })

  it("a truncated hold list fails the step", async () => {
    const raw = rawSummary()
    raw.holds_truncated = true
    const h = harness({ body: raw })
    await runGate(inputs(), h.deps)
    expect(h.core.setFailed.mock.calls[0]![0]).toMatch(/hold list truncated; cannot evaluate every hold/)
    expect(h.attest.mock.calls[0]![0].predicate.holds_truncated).toBe(true)
  })
})

describe("runGate — signing skips are visible and never fail on their own", () => {
  it("dry-run: no signature, never fails the step even on a fail decision", async () => {
    const raw = rawSummary()
    raw.sentinels.critical = 1
    const h = harness({ body: raw })
    const out = await runGate(inputs({ dryRun: true }), h.deps)
    expect(out).toMatchObject({ decision: "fail", attestation: "skipped:dry-run" })
    expect(h.attest).not.toHaveBeenCalled()
    expect(h.request).not.toHaveBeenCalled()
    expect(h.core.setFailed).not.toHaveBeenCalled()
    expect(h.outputs["bundle-path"]).toBeUndefined()
    expect(h.outputs["statement-path"]).toBeDefined() // the would-be statement is still inspectable
    expect(h.lastBody()).toContain("(dry run): would **fail** — not enforced")
    expect(h.lastBody()).toContain("unsigned (dry-run)")
    expect(h.core.notice.mock.calls.flat().join("\n")).toMatch(/NOT signed \(dry-run\)/)
  })

  it("dry-run: infrastructure errors warn instead of failing", async () => {
    const h = harness({ status: 503, body: { error: "unavailable" } })
    await runGate(inputs({ dryRun: true }), h.deps)
    expect(h.core.setFailed).not.toHaveBeenCalled()
    expect(h.core.warning.mock.calls.flat().join("\n")).toMatch(/api-error.*not failing the step \(dry-run\)/)
  })

  it("fork PR: not signed, labelled, decision still enforced", async () => {
    const ctx = prContext({
      payload: {
        pull_request: {
          number: 7,
          head: { sha: HEAD_SHA, repo: { full_name: "mallory/widgets" } },
          base: { repo: { full_name: "acme/widgets" } },
        },
      },
    })
    const h = harness({ context: ctx })
    const out = await runGate(inputs(), h.deps)
    expect(out).toMatchObject({ decision: "pass", attestation: "skipped:fork" })
    expect(h.attest).not.toHaveBeenCalled()
    expect(h.core.setFailed).not.toHaveBeenCalled()
    expect(h.lastBody()).toContain("unsigned (fork)")
  })

  it("missing id-token permission: not signed, warned, labelled", async () => {
    const h = harness({ env: { RUNNER_TEMP: "/runner/tmp" } })
    const out = await runGate(inputs(), h.deps)
    expect(out.attestation).toBe("skipped:permissions")
    expect(h.attest).not.toHaveBeenCalled()
    expect(h.core.warning.mock.calls.flat().join("\n")).toMatch(/NOT signed \(permissions\).*id-token: write/)
    expect(h.lastBody()).toContain("unsigned (permissions)")
  })

  it("fork PR without secrets: explains why the key is empty", async () => {
    const ctx = prContext({
      payload: {
        pull_request: { number: 7, head: { sha: HEAD_SHA, repo: { full_name: "mallory/widgets" } }, base: { repo: { full_name: "acme/widgets" } } },
      },
    })
    const h = harness({ context: ctx })
    await runGate(inputs({ apiKey: "" }), h.deps)
    expect(h.core.setFailed.mock.calls[0]![0]).toMatch(/fork.*does not pass repository secrets/)
    expect(h.fetch).not.toHaveBeenCalled()
  })
})

describe("runGate — signing failures are reported, never silently passed", () => {
  it("attest() throwing → attestation: failed, comment says so, step fails (fail-on-error default)", async () => {
    const h = harness({ attest: vi.fn().mockRejectedValue(new Error("fulcio: 503")) })
    const out = await runGate(inputs(), h.deps)
    expect(out).toMatchObject({ decision: "pass", attestation: "failed" })
    expect(h.core.setFailed).toHaveBeenCalledOnce()
    expect(h.core.setFailed.mock.calls[0]![0]).toMatch(/signing-failed.*Sigstore signing failed: fulcio: 503/)
    expect(h.lastBody()).toContain("**signing failed**")
    expect(h.outputs["bundle-path"]).toBeUndefined()
  })

  it("attest() throwing with fail-on-error false → warned, not failed, still labelled", async () => {
    const h = harness({ attest: vi.fn().mockRejectedValue(new Error("boom")) })
    await runGate(inputs({ failOnError: false }), h.deps)
    expect(h.core.setFailed).not.toHaveBeenCalled()
    expect(h.core.warning.mock.calls.flat().join("\n")).toMatch(/signing-failed.*continuing \(fail-on-error is false\)/)
    expect(h.outputs.attestation).toBe("failed")
  })

  it("store refused → signed-not-stored: bundle kept, warned, no attestation-url", async () => {
    const h = harness()
    h.request.mockRejectedValue(Object.assign(new Error("Resource not accessible by integration"), { status: 403 }))
    const out = await runGate(inputs(), h.deps)
    expect(out.attestation).toBe("signed-not-stored")
    expect(h.outputs["bundle-path"]).toBeDefined()
    expect(h.outputs["attestation-url"]).toBeUndefined()
    expect(h.core.setFailed).not.toHaveBeenCalled()
    expect(h.core.warning.mock.calls.flat().join("\n")).toMatch(/signed but NOT stored.*HTTP 403.*attestations: write/)
    expect(h.lastBody()).toContain("**not stored**")
  })
})

describe("runGate — facts unavailable: no decision, nothing signed", () => {
  it("API 404 → error comment + failed step (gate fails closed by default)", async () => {
    const h = harness({ status: 404, body: { error: "not_found" } })
    const out = await runGate(inputs(), h.deps)
    expect(out.decision).toBeUndefined()
    expect(out.status).toBe("skipped:api-error")
    expect(h.attest).not.toHaveBeenCalled()
    expect(h.outputs.decision).toBeUndefined()
    expect(h.core.setFailed.mock.calls[0]![0]).toMatch(/api-error.*no decision was made and nothing was signed/)
    expect(h.lastBody()).toContain("could not evaluate")
  })

  it("API down with fail-on-error false → warns (fail open is an explicit opt-in)", async () => {
    const h = harness()
    h.fetch.mockRejectedValue(new Error("ECONNREFUSED"))
    await runGate(inputs({ failOnError: false }), h.deps)
    expect(h.core.setFailed).not.toHaveBeenCalled()
    expect(h.core.warning).toHaveBeenCalled()
  })

  it("unsupported summary_version → skipped:unsupported-summary with the clear error", async () => {
    const raw = rawSummary()
    raw.machinaut.summary_version = "governance_summary@2"
    const h = harness({ body: raw })
    const out = await runGate(inputs(), h.deps)
    expect(out.status).toBe("skipped:unsupported-summary")
    expect(h.attest).not.toHaveBeenCalled()
    expect(h.core.setFailed.mock.calls[0]![0]).toMatch(/understands only 'governance_summary@1'/)
  })
})

describe("runGate — applicability and PR resolution", () => {
  it("no session id → not applicable: skips without calling Machinaut or failing", async () => {
    const h = harness()
    const out = await runGate(inputs({ sessionId: "" }), h.deps)
    expect(out.status).toBe("skipped:no-session")
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.core.setFailed).not.toHaveBeenCalled()
  })

  it("issue_comment: reads the PR head from the API for the gitCommit subject", async () => {
    const h = harness({
      context: prContext({ eventName: "issue_comment", payload: { issue: { number: 7, pull_request: {} } } }),
    })
    await runGate(inputs(), h.deps)
    expect(h.pullsGet).toHaveBeenCalledWith({ owner: "acme", repo: "widgets", pull_number: 7 })
    expect(h.attest.mock.calls[0]![0].subjects[0].digest.gitCommit).toBe(HEAD_SHA)
  })

  it("uses the PR head SHA, not the pull_request merge commit (context.sha)", async () => {
    const h = harness()
    await runGate(inputs(), h.deps)
    expect(h.pullsGet).not.toHaveBeenCalled()
    expect(h.attest.mock.calls[0]![0].subjects[0].digest.gitCommit).toBe(HEAD_SHA)
  })

  it("comment failure is an infrastructure error (fails under the gate default)", async () => {
    const h = harness({ createError: Object.assign(new Error("Resource not accessible"), { status: 403 }) })
    const out = await runGate(inputs(), h.deps)
    expect(out.status).toBe("skipped:comment-failed")
    expect(h.core.setFailed.mock.calls[0]![0]).toMatch(/comment-failed/)
  })
})
