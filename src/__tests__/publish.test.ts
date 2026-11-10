import { describe, expect, it, vi } from "vitest"
import {
  buildShareUrl,
  formatExpiryDate,
  type PublishSkipReason,
  publishOutput,
  publishReasonText,
  publishShare,
  prSubject,
  redact,
} from "../publish"

const TOKEN = "mp_test_secret_value_1234"
const SHARE_TOKEN = "sh_AbCdEfGhIjKlMnOpQrStUvWxYz012345"

const req = {
  apiUrl: "https://console.machinaut.ai/",
  publishToken: TOKEN,
  projectId: "demo",
  sessionId: "sess-demo",
  subject: "github.com/acme/widgets/pull/7",
}

const res = (status: number, body?: unknown) => new Response(body === undefined ? "" : JSON.stringify(body), { status })
const run = (f: ReturnType<typeof vi.fn>, r: typeof req = req) => publishShare(r, { fetch: f as unknown as typeof fetch })

function shareBody(over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
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
      ...over,
    },
    reused: false,
    ...top,
  }
}

describe("publishShare — the request", () => {
  it("POSTs /v1/publish/shares with the publish token as bearer and no label", async () => {
    const f = vi.fn().mockResolvedValue(res(201, shareBody()))
    await run(f)
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe("https://console.machinaut.ai/v1/publish/shares")
    expect(init.method).toBe("POST")
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(init.headers["content-type"]).toBe("application/json")
    const body = JSON.parse(init.body)
    expect(body).toEqual({ project_id: "demo", session_id: "sess-demo", subject: "github.com/acme/widgets/pull/7" })
    expect(body).not.toHaveProperty("label") // ADR-0002 decision 16: a label is public
  })

  it("omits subject when none is given", async () => {
    const f = vi.fn().mockResolvedValue(res(201, shareBody()))
    await run(f, { ...req, subject: undefined as unknown as string })
    expect(JSON.parse(f.mock.calls[0]![1].body)).toEqual({ project_id: "demo", session_id: "sess-demo" })
  })
})

describe("publishShare — success", () => {
  it("201 → a new public link", async () => {
    const r = await run(vi.fn().mockResolvedValue(res(201, shareBody({}, { replaced_share_id: "old-share-id" }))))
    expect(r).toEqual({
      ok: true,
      status: 201,
      reused: false,
      share: { token: SHARE_TOKEN, expiresAt: "2026-12-10T10:47:00.000Z", ceiling: "public", replacedShareId: "old-share-id" },
    })
  })

  it("200 → this token's live link, reused (both are success)", async () => {
    const r = await run(vi.fn().mockResolvedValue(res(200, shareBody({}, { reused: true }))))
    expect(r).toMatchObject({ ok: true, status: 200, reused: true, share: { token: SHARE_TOKEN } })
  })

  it("200 without a reused flag still reads as a reuse", async () => {
    const body = shareBody()
    delete (body as Record<string, unknown>).reused
    const r = await run(vi.fn().mockResolvedValue(res(200, body)))
    expect(r).toMatchObject({ ok: true, reused: true })
  })

  it("a missing or invalid expires_at is dropped, not fatal", async () => {
    const r = await run(vi.fn().mockResolvedValue(res(201, shareBody({ expires_at: "soon" }))))
    expect(r.ok && r.share.expiresAt).toBeUndefined()
  })

  it.each([
    ["no share", { reused: false }],
    ["no token", shareBody({ token: undefined })],
    ["a token that is not a share token", shareBody({ token: "javascript:alert(1)" })],
    ["a share for another session", shareBody({ session_id: "sess-other" })],
    ["a share for another project", shareBody({ project_id: "other" })],
  ])("2xx with %s → bad-response", async (_label, body) => {
    const r = await run(vi.fn().mockResolvedValue(res(201, body)))
    expect(r).toMatchObject({ ok: false, reason: "bad-response" })
  })

  it("a 2xx other than 200/201 is not read as success", async () => {
    const r = await run(vi.fn().mockResolvedValue(res(202, shareBody())))
    expect(r).toMatchObject({ ok: false, reason: "api-error", status: 202 })
  })
})

describe("publishShare — refusals and errors (never thrown)", () => {
  it.each<[number, Record<string, unknown>, PublishSkipReason]>([
    [400, { error: "bad_request", message: "share body failed validation" }, "bad-request"],
    [401, { error: "invalid_publish_token", message: "invalid publish token" }, "unauthorized"],
    [402, { error: "quota_exceeded", message: "share quota reached" }, "quota-exceeded"],
    [403, { error: "project_scope_conflict", message: "token is pinned to another project" }, "project-scope-conflict"],
    [404, { error: "not_found", message: "not found" }, "not-found"],
    [409, { error: "not_publishable", reason: "ceiling_above_token", message: "ship with --sensitivity-ceiling public" }, "ceiling-above-token"],
    [409, { error: "not_publishable", reason: "ceiling_unknown" }, "ceiling-unknown"],
    [409, { error: "not_publishable", reason: "session_too_old" }, "session-too-old"],
    [409, { error: "not_publishable" }, "not-publishable"],
    [403, { error: "not_publishable", reason: "ceiling_above_token" }, "ceiling-above-token"],
    [429, { error: "rate_limited", message: "slow down" }, "rate-limited"],
    [500, { error: "internal", message: "boom" }, "api-error"],
    [503, {}, "api-error"],
  ])("HTTP %i %j → skipped:%s", async (status, body, reason) => {
    const r = await run(vi.fn().mockResolvedValue(res(status, body)))
    expect(r).toMatchObject({ ok: false, status, reason })
    if (!r.ok) expect(r.message).toContain(`HTTP ${status}`)
  })

  it("a non-JSON error body still classifies by status", async () => {
    const r = await run(vi.fn().mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 })))
    expect(r).toMatchObject({ ok: false, status: 502, reason: "api-error" })
  })

  it("retries once on a network error and recovers", async () => {
    const f = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce(res(201, shareBody()))
    expect(await run(f)).toMatchObject({ ok: true })
    expect(f).toHaveBeenCalledTimes(2)
  })

  it("gives up after one retry with network-error", async () => {
    const f = vi.fn().mockRejectedValue(new Error("ENOTFOUND"))
    expect(await run(f)).toMatchObject({ ok: false, status: 0, reason: "network-error" })
    expect(f).toHaveBeenCalledTimes(2)
  })

  it("times out instead of hanging", async () => {
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const e = new Error("aborted")
            e.name = "AbortError"
            reject(e)
          })
        }),
    )
    const r = await publishShare(req, { fetch: hang as unknown as typeof fetch, timeoutMs: 5 })
    expect(r).toMatchObject({ ok: false, reason: "network-error" })
    if (!r.ok) expect(r.message).toContain("timed out after 5ms")
  })

  it("does not retry HTTP errors", async () => {
    const f = vi.fn().mockResolvedValue(res(500, {}))
    await run(f)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it("an invalid api-url is reported, not thrown", async () => {
    const r = await run(vi.fn(), { ...req, apiUrl: "not a url" })
    expect(r).toMatchObject({ ok: false, reason: "network-error" })
  })

  it("never echoes the publish token, even when the server or the network error does", async () => {
    const echo = await run(vi.fn().mockResolvedValue(res(401, { error: "invalid_publish_token", message: `token ${TOKEN} is revoked` })))
    expect(JSON.stringify(echo)).not.toContain(TOKEN)
    const net = await run(vi.fn().mockRejectedValue(new Error(`failed for Bearer ${TOKEN}`)))
    expect(JSON.stringify(net)).not.toContain(TOKEN)
  })

  it("does not trust a malformed server code", async () => {
    const r = await run(vi.fn().mockResolvedValue(res(409, { error: "<b>x</b>", reason: "ceiling_above_token<script>" })))
    expect(r).toMatchObject({ ok: false, reason: "not-publishable" })
    if (!r.ok) expect(r.code).toBeUndefined()
  })
})

describe("publish helpers", () => {
  it("buildShareUrl joins the console origin and /s/<token>", () => {
    expect(buildShareUrl("https://console.machinaut.ai/", SHARE_TOKEN)).toBe(`https://console.machinaut.ai/s/${SHARE_TOKEN}`)
  })

  it("prSubject is the PR path on the run's GitHub host", () => {
    expect(prSubject("https://github.com", "acme", "widgets", 7)).toBe("github.com/acme/widgets/pull/7")
    expect(prSubject("https://ghe.example.com", "acme", "widgets", 7)).toBe("ghe.example.com/acme/widgets/pull/7")
    expect(prSubject(undefined, "acme", "widgets", 7)).toBe("github.com/acme/widgets/pull/7")
    expect(prSubject("::", "acme", "widgets", 7)).toBe("github.com/acme/widgets/pull/7")
    expect(prSubject("https://github.com", "o", "r".repeat(200), 1)).toBeUndefined() // > 200 chars
  })

  it("formatExpiryDate renders the UTC date", () => {
    expect(formatExpiryDate("2026-12-10T23:30:00-05:00")).toBe("2026-12-11")
    expect(formatExpiryDate(undefined)).toBeUndefined()
    expect(formatExpiryDate("nope")).toBeUndefined()
  })

  it("publishOutput", () => {
    expect(publishOutput({ kind: "published", reused: false, url: "u" })).toBe("published")
    expect(publishOutput({ kind: "published", reused: true, url: "u" })).toBe("reused")
    expect(publishOutput({ kind: "skipped", reason: "fork", configured: true })).toBe("skipped:fork")
  })

  it("redact", () => {
    expect(redact(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe("a *** b ***")
    expect(redact("unchanged", "")).toBe("unchanged")
  })

  it("every reason but no-token has one line of fixed copy", () => {
    const reasons: PublishSkipReason[] = [
      "fork",
      "fork-check-failed",
      "invalid-token",
      "bad-request",
      "unauthorized",
      "quota-exceeded",
      "project-scope-conflict",
      "not-found",
      "ceiling-above-token",
      "ceiling-unknown",
      "session-too-old",
      "not-publishable",
      "rate-limited",
      "api-error",
      "network-error",
      "bad-response",
    ]
    for (const r of reasons) {
      const text = publishReasonText(r, 500)
      expect(text, r).toBeTruthy()
      expect(text!.includes("\n"), r).toBe(false)
    }
    expect(publishReasonText("no-token")).toBeUndefined()
    expect(publishReasonText("ceiling-above-token")).toContain("--sensitivity-ceiling public")
    expect(publishReasonText("ceiling-above-token")).toContain("`internal`")
    expect(publishReasonText("api-error", 503)).toContain("HTTP 503")
  })
})
