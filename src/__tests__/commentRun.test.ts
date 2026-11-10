import { describe, expect, it, vi } from "vitest"
import { renderComment, STICKY_MARKER } from "../comment"
import { type CommentDeps, type CommentGitHubApi, type PullRepos, runComment } from "../commentRun"
import type { GateContext } from "../gateRun"
import type { Inputs } from "../inputs"
import type { SessionReport } from "../machinaut"

const PUBLISH_TOKEN = "mp_live_publish_secret_abcdef"
const SHARE_TOKEN = "sh_AbCdEfGhIjKlMnOpQrStUvWxYz012345"
const SESSION_URL = "https://console.machinaut.ai/projects/demo/sessions/sess-demo"
const SHARE_URL = `https://console.machinaut.ai/s/${SHARE_TOKEN}`

const REPORT: SessionReport = {
  projection: {
    event_count: 13,
    actor_ids: ["planner", "executor"],
    first_event_at: "2026-07-19T00:00:00Z",
    last_event_at: "2026-07-19T00:00:04.2Z",
    actions: [{ terminal_phase: "executed", outcome: { result: "success" } }],
  },
  report_markdown: "# Lodestar trust report\n\n**Events**: 13",
}

function inputs(overrides: Partial<Inputs> = {}): Inputs {
  return {
    apiKey: "mk_project_key",
    projectId: "demo",
    sessionId: "sess-demo",
    apiUrl: "https://console.machinaut.ai",
    consoleUrl: "https://console.machinaut.ai",
    githubToken: "ghs_x",
    failOnError: false, // comment-mode default
    mode: "comment",
    policy: { requireHoldsResolved: true, requireBoundApprovals: false, maxSentinelSeverity: "warning", allowUnreadable: false },
    dryRun: false,
    postAttestation: true,
    publishToken: "",
    ...overrides,
  }
}

const SAME_REPO = { full_name: "acme/widgets" }
const FORK_REPO = { full_name: "mallory/widgets" }

function prContext(head: { full_name: string } | null = SAME_REPO, overrides: Partial<GateContext> = {}): GateContext {
  return {
    eventName: "pull_request",
    sha: "merge-commit-sha",
    payload: { pull_request: { number: 7, head: { sha: "a".repeat(40), repo: head }, base: { repo: SAME_REPO } } },
    repo: { owner: "acme", repo: "widgets" },
    serverUrl: "https://github.com",
    ...overrides,
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

function shareBody(reused = false) {
  return {
    beta: true,
    share: {
      id: "11111111-2222-3333-4444-555555555555",
      token: SHARE_TOKEN,
      path: `/s/${SHARE_TOKEN}`,
      project_id: "demo",
      session_id: "sess-demo",
      subject: "github.com/acme/widgets/pull/7",
      expires_at: "2026-12-10T10:47:00.000Z",
      ceiling: "public",
    },
    reused,
  }
}

interface Harness {
  deps: CommentDeps
  outputs: Record<string, string>
  core: { info: any; notice: any; warning: any; setOutput: any; setFailed: any }
  fetch: ReturnType<typeof vi.fn>
  publishCalls: () => [string, RequestInit][]
  createComment: ReturnType<typeof vi.fn>
  pullsGet: ReturnType<typeof vi.fn>
  body: () => string
  everythingLogged: () => string
}

function harness(opts: {
  context?: GateContext
  publish?: () => Response | Promise<Response>
  reportStatus?: number
  pull?: PullRepos | Error
} = {}): Harness {
  const outputs: Record<string, string> = {}
  const core = {
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    setOutput: vi.fn((k: string, v: string) => (outputs[k] = v)),
    setFailed: vi.fn(),
  }
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/v1/publish/shares")) {
      if (!opts.publish) throw new Error("unexpected publish call")
      return opts.publish()
    }
    const status = opts.reportStatus ?? 200
    return status === 200 ? json(200, REPORT) : json(status, { error: "not_found", message: "no such session" })
  })
  const createComment = vi.fn(async ({ body }: { body: string }) => ({
    data: { id: 99, html_url: "https://github.com/acme/widgets/pull/7#issuecomment-99", body },
  }))
  const pullsGet = vi.fn(async () => {
    if (opts.pull instanceof Error) throw opts.pull
    return { data: opts.pull ?? { head: { repo: SAME_REPO }, base: { repo: SAME_REPO } } }
  })
  const octokit: CommentGitHubApi = {
    paginate: vi.fn(async () => []) as CommentGitHubApi["paginate"],
    rest: {
      issues: { listComments: {}, createComment, updateComment: vi.fn() },
      repos: { listPullRequestsAssociatedWithCommit: {} },
      pulls: { get: pullsGet },
    },
  }
  const deps: CommentDeps = {
    core,
    context: opts.context ?? prContext(),
    octokit: () => octokit,
    fetch: fetchMock as unknown as typeof fetch,
  }
  return {
    deps,
    outputs,
    core,
    fetch: fetchMock,
    publishCalls: () =>
      fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/v1/publish/shares")) as unknown as [string, RequestInit][],
    createComment,
    pullsGet,
    body: () => (createComment.mock.calls.at(-1)?.[0] as { body: string } | undefined)?.body ?? "",
    everythingLogged: () =>
      JSON.stringify([core.info.mock.calls, core.notice.mock.calls, core.warning.mock.calls, core.setFailed.mock.calls, outputs]),
  }
}

/** The comment exactly as this action rendered it before the publish feature. */
const UNCHANGED_BODY = renderComment({ report: REPORT, sessionUrl: SESSION_URL })

describe("runComment — no publish token (existing behaviour unchanged)", () => {
  it("never calls the publish endpoint and posts the same comment as before", async () => {
    const h = harness()
    await runComment(inputs(), h.deps)
    expect(h.publishCalls()).toHaveLength(0)
    expect(h.fetch).toHaveBeenCalledTimes(1) // the report read only
    expect(h.body()).toBe(UNCHANGED_BODY)
    expect(h.body()).not.toContain("Public link not published")
    expect(h.outputs).toMatchObject({ status: "created", publish: "skipped:no-token", "share-url": "", "session-url": SESSION_URL })
    expect(h.core.warning).not.toHaveBeenCalled()
    expect(h.core.setFailed).not.toHaveBeenCalled()
  })

  it("a fork run without a token reports skipped:fork, still with the unchanged comment", async () => {
    const h = harness({ context: prContext(FORK_REPO) })
    await runComment(inputs(), h.deps)
    expect(h.outputs.publish).toBe("skipped:fork")
    expect(h.body()).toBe(UNCHANGED_BODY)
  })

  it("keeps the Increment 1 skips and failures", async () => {
    const noSession = harness()
    await runComment(inputs({ sessionId: "" }), noSession.deps)
    expect(noSession.outputs.status).toBe("skipped:no-session")
    expect(noSession.fetch).not.toHaveBeenCalled()

    const noKey = harness()
    await runComment(inputs({ apiKey: "", publishToken: PUBLISH_TOKEN, failOnError: true }), noKey.deps)
    expect(noKey.outputs.status).toBe("skipped:no-api-key")
    expect(noKey.core.setFailed).toHaveBeenCalledTimes(1)
    expect(noKey.publishCalls()).toHaveLength(0)

    const missing = harness({ reportStatus: 404, publish: () => json(201, shareBody()) })
    await runComment(inputs({ publishToken: PUBLISH_TOKEN }), missing.deps)
    expect(missing.outputs.status).toBe("skipped:session-not-found")
    expect(missing.publishCalls()).toHaveLength(0) // never mint a link for a run that posts no comment
    expect(missing.createComment).not.toHaveBeenCalled()
  })
})

describe("runComment — publishing", () => {
  it("201: mints the public link and leads the comment with it", async () => {
    const h = harness({ publish: () => json(201, shareBody()) })
    await runComment(inputs({ publishToken: PUBLISH_TOKEN }), h.deps)

    const [[url, init]] = h.publishCalls() as [[string, RequestInit & { headers: Record<string, string> }]]
    expect(url).toBe("https://console.machinaut.ai/v1/publish/shares")
    expect(init.headers.authorization).toBe(`Bearer ${PUBLISH_TOKEN}`)
    expect(JSON.parse(String(init.body))).toEqual({
      project_id: "demo",
      session_id: "sess-demo",
      subject: "github.com/acme/widgets/pull/7",
    })
    // The report read used the project key, never the publish token.
    const reportCall = h.fetch.mock.calls.find(([u]) => !String(u).endsWith("/v1/publish/shares"))!
    expect((reportCall[1] as { headers: Record<string, string> }).headers.authorization).toBe("Bearer mk_project_key")

    expect(h.outputs).toMatchObject({ status: "created", publish: "published", "share-url": SHARE_URL })
    const body = h.body()
    expect(body.startsWith(STICKY_MARKER)).toBe(true)
    expect(body).toContain(`[Open the public post-mortem →](${SHARE_URL}?ref=pr-comment)`)
    expect(body).toContain("Public post-mortem link (Beta). Anyone with the link can view it. Expires 2026-12-10 (UTC).")
    expect(body).toContain(`(${SESSION_URL}?ref=pr-comment)`) // the team console stays linked
    expect(body).toContain("sign-in required")
    expect(body).not.toContain("not** a public post-mortem")
    expect(body).not.toContain("Public link not published")
    expect(h.core.warning).not.toHaveBeenCalled()
  })

  it("200: reuses the live link (success, publish=reused)", async () => {
    const h = harness({ publish: () => json(200, shareBody(true)) })
    await runComment(inputs({ publishToken: PUBLISH_TOKEN }), h.deps)
    expect(h.outputs).toMatchObject({ publish: "reused", "share-url": SHARE_URL, status: "created" })
    expect(h.body()).toContain(`(${SHARE_URL}?ref=pr-comment)`)
  })

  it("issue_comment (payload names no head repo): checks the PR via the API, then publishes", async () => {
    const h = harness({
      context: prContext(SAME_REPO, { eventName: "issue_comment", payload: { issue: { number: 7, pull_request: {} } } }),
      publish: () => json(201, shareBody()),
    })
    await runComment(inputs({ publishToken: PUBLISH_TOKEN }), h.deps)
    expect(h.pullsGet).toHaveBeenCalledWith({ owner: "acme", repo: "widgets", pull_number: 7 })
    expect(h.outputs.publish).toBe("published")
  })

  it("workflow_run whose triggering run was same-repo: still checks the PR itself (fork → skipped)", async () => {
    const context = prContext(SAME_REPO, {
      eventName: "workflow_run",
      payload: {
        workflow_run: {
          head_sha: "b".repeat(40),
          pull_requests: [{ number: 7 }],
          head_repository: SAME_REPO, // e.g. it followed a base-context pull_request_target run
          repository: SAME_REPO,
        },
      },
    })
    const fork = harness({ context, pull: { head: { repo: FORK_REPO }, base: { repo: SAME_REPO } }, publish: () => json(201, shareBody()) })
    await runComment(inputs({ publishToken: PUBLISH_TOKEN }), fork.deps)
    expect(fork.pullsGet).toHaveBeenCalledWith({ owner: "acme", repo: "widgets", pull_number: 7 })
    expect(fork.publishCalls()).toHaveLength(0)
    expect(fork.outputs.publish).toBe("skipped:fork")

    const same = harness({ context, publish: () => json(201, shareBody()) })
    await runComment(inputs({ publishToken: PUBLISH_TOKEN }), same.deps)
    expect(same.pullsGet).toHaveBeenCalledTimes(1)
    expect(same.outputs.publish).toBe("published")
  })

  it("with no pull_request in the payload, the resolved PR itself is always checked", async () => {
    const context = prContext(SAME_REPO, {
      eventName: "workflow_dispatch",
      payload: { workflow_run: { pull_requests: [{ number: 7 }] } },
    })
    const h = harness({ context, publish: () => json(201, shareBody()) })
    await runComment(inputs({ publishToken: PUBLISH_TOKEN }), h.deps)
    expect(h.pullsGet).toHaveBeenCalledTimes(1)
    expect(h.outputs.publish).toBe("published")
  })

  it("does not call pulls.get when the payload already rules out a fork", async () => {
    const h = harness({ publish: () => json(201, shareBody()) })
    await runComment(inputs({ publishToken: PUBLISH_TOKEN }), h.deps)
    expect(h.pullsGet).not.toHaveBeenCalled()
  })
})

describe("runComment — forks never publish", () => {
  const forkCases: [string, GateContext][] = [
    ["pull_request from a fork", prContext(FORK_REPO)],
    ["pull_request from a deleted fork", prContext(null)],
    ["pull_request_target from a fork", prContext(FORK_REPO, { eventName: "pull_request_target" })],
    [
      "workflow_run from a fork's pull_request",
      prContext(SAME_REPO, {
        eventName: "workflow_run",
        payload: {
          workflow_run: {
            head_sha: "b".repeat(40),
            pull_requests: [{ number: 7 }],
            head_repository: FORK_REPO,
            repository: SAME_REPO,
          },
        },
      }),
    ],
  ]

  it.each(forkCases)("%s: no publish call, skipped:fork, console link + reason", async (_label, context) => {
    const h = harness({ context, publish: () => json(201, shareBody()) })
    await runComment(inputs({ publishToken: PUBLISH_TOKEN, failOnError: true }), h.deps)
    expect(h.publishCalls()).toHaveLength(0)
    expect(h.outputs).toMatchObject({ publish: "skipped:fork", "share-url": "", status: "created" })
    expect(h.body()).toContain(`(${SESSION_URL}?ref=pr-comment)`)
    expect(h.body()).toContain("Public link not published: this pull request comes from a fork")
    expect(h.core.notice).toHaveBeenCalledWith(expect.stringContaining("publish skipped (fork)"))
    expect(h.core.setFailed).not.toHaveBeenCalled()
  })

  it("issue_comment on a fork's PR (found via the API): skipped:fork", async () => {
    const h = harness({
      context: prContext(SAME_REPO, { eventName: "issue_comment", payload: { issue: { number: 7, pull_request: {} } } }),
      pull: { head: { repo: FORK_REPO }, base: { repo: SAME_REPO } },
      publish: () => json(201, shareBody()),
    })
    await runComment(inputs({ publishToken: PUBLISH_TOKEN }), h.deps)
    expect(h.publishCalls()).toHaveLength(0)
    expect(h.outputs.publish).toBe("skipped:fork")
  })

  it.each<[string, PullRepos | Error]>([
    ["the PR lookup fails", Object.assign(new Error("Bad credentials"), { status: 401 })],
    ["the PR names no repos", { head: { repo: {} }, base: { repo: {} } }],
  ])("unsure (%s): does not publish, skipped:fork-check-failed", async (_label, pull) => {
    const h = harness({
      context: prContext(SAME_REPO, { eventName: "issue_comment", payload: { issue: { number: 7, pull_request: {} } } }),
      pull,
      publish: () => json(201, shareBody()),
    })
    await runComment(inputs({ publishToken: PUBLISH_TOKEN, failOnError: true }), h.deps)
    expect(h.publishCalls()).toHaveLength(0)
    expect(h.outputs).toMatchObject({ publish: "skipped:fork-check-failed", status: "created" })
    expect(h.body()).toContain("Public link not published: the action could not confirm")
    expect(h.core.setFailed).not.toHaveBeenCalled()
  })
})

describe("runComment — refusals and errors degrade, never fail the step", () => {
  const cases: [string, () => Response | Promise<Response>, string, string][] = [
    ["400", () => json(400, { error: "bad_request" }), "skipped:bad-request", "malformed"],
    ["401", () => json(401, { error: "invalid_publish_token" }), "skipped:unauthorized", "did not accept the publish token"],
    ["402", () => json(402, { error: "quota_exceeded" }), "skipped:quota-exceeded", "share-link quota"],
    ["403", () => json(403, { error: "project_scope_conflict" }), "skipped:project-scope-conflict", "pinned to a different"],
    ["404", () => json(404, { error: "not_found" }), "skipped:not-found", "answered 404"],
    [
      "409 ceiling_above_token",
      () => json(409, { error: "not_publishable", reason: "ceiling_above_token" }),
      "skipped:ceiling-above-token",
      "--sensitivity-ceiling public",
    ],
    [
      "409 ceiling_unknown",
      () => json(409, { error: "not_publishable", reason: "ceiling_unknown" }),
      "skipped:ceiling-unknown",
      "no recorded sensitivity ceiling",
    ],
    [
      "409 session_too_old",
      () => json(409, { error: "not_publishable", reason: "session_too_old" }),
      "skipped:session-too-old",
      "freshness window",
    ],
    ["429", () => json(429, { error: "rate_limited" }), "skipped:rate-limited", "rate limit"],
    ["500", () => json(500, { error: "internal" }), "skipped:api-error", "(HTTP 500)"],
    [
      "network",
      () => {
        throw new TypeError("fetch failed")
      },
      "skipped:network-error",
      "could not be reached",
    ],
    ["malformed 201", () => json(201, { share: { token: "nope" } }), "skipped:bad-response", "could not be read"],
  ]

  it.each(cases)("%s → %s; console link + one-line reason", async (_label, publish, output, reasonFragment) => {
    const h = harness({ publish })
    await runComment(inputs({ publishToken: PUBLISH_TOKEN, failOnError: true }), h.deps)
    expect(h.outputs).toMatchObject({ publish: output, "share-url": "", status: "created" })
    const body = h.body()
    expect(body).toContain(`**[Open this session in Machinaut →](${SESSION_URL}?ref=pr-comment)**`)
    expect(body).toContain("not** a public post-mortem link")
    const reasonLine = body.split("\n").find((l) => l.startsWith("Public link not published: "))
    expect(reasonLine).toBeDefined()
    expect(reasonLine).toContain(reasonFragment)
    expect(h.core.warning).toHaveBeenCalledWith(expect.stringContaining(`publish (${output.slice("skipped:".length)})`))
    expect(h.core.setFailed).not.toHaveBeenCalled() // even with fail-on-error: true
  })

  it("a project key in the publish-token input is refused locally and never sent", async () => {
    const h = harness({ publish: () => json(201, shareBody()) })
    await runComment(inputs({ publishToken: "mk_project_key_by_mistake", failOnError: true }), h.deps)
    expect(h.publishCalls()).toHaveLength(0)
    expect(h.outputs.publish).toBe("skipped:invalid-token")
    expect(h.body()).toContain("Public link not published: `machinaut-publish-token` is not a Machinaut CI publish token")
    expect(h.core.setFailed).not.toHaveBeenCalled()
  })

  it("never prints the publish token, even when the server echoes it", async () => {
    const h = harness({
      publish: () => json(401, { error: "invalid_publish_token", message: `token ${PUBLISH_TOKEN} was revoked` }),
    })
    await runComment(inputs({ publishToken: PUBLISH_TOKEN }), h.deps)
    expect(h.everythingLogged()).not.toContain(PUBLISH_TOKEN)
    expect(h.body()).not.toContain(PUBLISH_TOKEN)
    expect(h.core.warning.mock.calls[0]![0]).toContain("token *** was revoked")
  })

  it("a comment failure after publishing still says the public link is live, and does not fail on publish", async () => {
    const h = harness({ publish: () => json(201, shareBody()) })
    h.createComment.mockRejectedValueOnce(Object.assign(new Error("Resource not accessible by integration"), { status: 403 }))
    await runComment(inputs({ publishToken: PUBLISH_TOKEN }), h.deps)
    expect(h.outputs).toMatchObject({ status: "skipped:comment-failed", publish: "published", "share-url": SHARE_URL })
    expect(h.core.warning).toHaveBeenCalledWith(expect.stringContaining(`public post-mortem link ${SHARE_URL} was published and is live`))
  })

  it("never prints the publish token on success either", async () => {
    const h = harness({ publish: () => json(201, shareBody()) })
    await runComment(inputs({ publishToken: PUBLISH_TOKEN }), h.deps)
    expect(h.everythingLogged()).not.toContain(PUBLISH_TOKEN)
    expect(h.body()).not.toContain(PUBLISH_TOKEN)
  })
})
