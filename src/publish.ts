import { normalizeBaseUrl } from "./machinaut"

/**
 * Public post-mortem link (Track C Increment 2, ADR-0002 in the control-plane
 * repo — PLANNED until the hosted console serves it).
 *
 * With the separate, owner-minted CI publish token (`mp_…`), comment mode asks
 * Machinaut to mint — or hand back — a public, expiring `/s/:token` share of the
 * session it just read:
 *
 *   POST {api-url}/v1/publish/shares
 *   Authorization: Bearer mp_…
 *   { "project_id", "session_id", "subject"? }      ← never a `label`: a label is public
 *
 *   201 { share: { token, expires_at, … }, reused: false }   a new link
 *   200 { share: { … }, reused: true }                       this token's live link for the session
 *
 * The server owns every rule (ceiling gate, freshness, expiry, one live link per
 * subject, quota, rate limit). This client only reports what happened: a refusal
 * or an error is never thrown and never fails the step — the comment falls back
 * to the sign-in-walled console link plus a one-line reason (ADR-0002 decision 20).
 *
 * The project key is never sent here: a project key cannot mint a public share,
 * by design. The publish token is never logged; any server text that echoes it is
 * redacted before it reaches a log line.
 */

export const PUBLISH_TOKEN_PREFIX = "mp_"
export const PUBLISH_PATH = "/v1/publish/shares"
export const PUBLISH_TIMEOUT_MS = 15_000
/** ADR-0002 decision 5: `subject` is opaque and at most 200 characters. */
export const SUBJECT_MAX = 200

/** A share token as the control plane mints it: `sh_` + base64url(24 bytes). */
const SHARE_TOKEN = /^sh_[A-Za-z0-9_-]{16,128}$/

export interface PublishRequest {
  apiUrl: string
  publishToken: string
  projectId: string
  sessionId: string
  /** `github.com/<owner>/<repo>/pull/<n>` — one live link per PR (server-enforced). */
  subject?: string
}

export interface PublishedShare {
  /** The share token (`sh_…`) — a published capability URL, not a secret. */
  token: string
  /** ISO timestamp; CI shares always expire (ADR-0002 decision 9). */
  expiresAt?: string
  /** The session's recorded sensitivity ceiling, as the server reports it. */
  ceiling?: string
  /** The previous live share this mint replaced under the same subject. */
  replacedShareId?: string
}

/**
 * Why a publish did not produce a link — the `publish` output is
 * `skipped:<reason>`. The first group is decided here before any call; the rest
 * classify the server's answer.
 */
export type PublishSkipReason =
  | "no-token"
  | "fork"
  | "fork-check-failed"
  | "invalid-token"
  | "bad-request"
  | "unauthorized"
  | "quota-exceeded"
  | "project-scope-conflict"
  | "not-found"
  | "ceiling-above-token"
  | "ceiling-unknown"
  | "session-too-old"
  | "not-publishable"
  | "rate-limited"
  | "api-error"
  | "network-error"
  | "bad-response"

export type PublishResult =
  | { ok: true; status: number; reused: boolean; share: PublishedShare }
  | { ok: false; status: number; reason: PublishSkipReason; code?: string; message: string }

interface Raw {
  status: number
  body?: unknown
  networkError?: string
}

/** Mint (or reuse) the public share. Never throws. */
export async function publishShare(
  req: PublishRequest,
  deps: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<PublishResult> {
  try {
    return await submit(req, deps)
  } catch (err) {
    // Belt and braces: a publish problem must never reach the comment run as a throw.
    return {
      ok: false,
      status: 0,
      reason: "network-error",
      message: redact(`publish request failed: ${errMessage(err)}`, req.publishToken),
    }
  }
}

async function submit(req: PublishRequest, deps: { fetch?: typeof fetch; timeoutMs?: number }): Promise<PublishResult> {
  const url = `${normalizeBaseUrl(req.apiUrl)}${PUBLISH_PATH}`
  const payload: Record<string, string> = { project_id: req.projectId, session_id: req.sessionId }
  if (req.subject) payload.subject = req.subject
  const body = JSON.stringify(payload)
  const doFetch = deps.fetch ?? fetch
  const timeoutMs = deps.timeoutMs ?? PUBLISH_TIMEOUT_MS

  const post = async (): Promise<Raw> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${req.publishToken}`,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": "machinaut-pr-action",
        },
        body,
        signal: controller.signal,
      })
      let parsed: unknown
      try {
        parsed = await res.json()
      } catch {
        /* non-JSON body; the status alone is enough */
      }
      return { status: res.status, body: parsed }
    } catch (err) {
      const reason = err instanceof Error && err.name === "AbortError" ? `timed out after ${timeoutMs}ms` : errMessage(err)
      return { status: 0, networkError: reason }
    } finally {
      clearTimeout(timer)
    }
  }

  // One retry, on a network error only. Safe: the server reuses this token's live
  // share for the session (200), so a request that did land is not minted twice.
  let raw = await post()
  if (raw.networkError !== undefined) raw = await post()
  return classify(raw, req)
}

const GATE_REASONS: Record<string, PublishSkipReason> = {
  ceiling_above_token: "ceiling-above-token",
  ceiling_unknown: "ceiling-unknown",
  session_too_old: "session-too-old",
}

function classify(raw: Raw, req: PublishRequest): PublishResult {
  const { status } = raw
  if (raw.networkError !== undefined) {
    return {
      ok: false,
      status: 0,
      reason: "network-error",
      message: redact(`Machinaut publish endpoint unreachable: ${raw.networkError}`, req.publishToken),
    }
  }

  if (status === 200 || status === 201) {
    const share = parseShare(raw.body, req)
    if (!share) {
      return { ok: false, status, reason: "bad-response", message: `Machinaut publish response (HTTP ${status}) carried no usable share` }
    }
    const reused = status === 200 || field(raw.body, "reused") === true
    return { ok: true, status, reused, share }
  }

  const code = safeCode(field(raw.body, "error"))
  const serverMessage = oneLine(field(raw.body, "message"), req.publishToken)
  const detail = `HTTP ${status}${code ? `, ${code}` : ""}${serverMessage ? ` — ${serverMessage}` : ""}`
  const fail = (reason: PublishSkipReason): PublishResult => ({
    ok: false,
    status,
    reason,
    code,
    message: `Machinaut did not publish the session (${detail})`,
  })

  // A gate refusal is recognised by its `reason`, whatever status carries it
  // (the contract says 409 `not_publishable`; a 403 carrying the same reason is
  // read the same way).
  const gateReason = safeCode(field(raw.body, "reason"))
  if (gateReason && GATE_REASONS[gateReason]) return fail(GATE_REASONS[gateReason]!)

  switch (status) {
    case 400:
      return fail("bad-request")
    case 401:
      return fail("unauthorized")
    case 402:
      return fail("quota-exceeded")
    case 403:
      return fail("project-scope-conflict")
    case 404:
      return fail("not-found")
    case 409:
      return fail("not-publishable")
    case 429:
      return fail("rate-limited")
    default:
      return fail("api-error")
  }
}

/**
 * The share out of a 200/201 body, or undefined when it is not one this action
 * can link honestly: the token must look like a share token (it is spliced into
 * a URL and a comment), and a share for a different project or session than the
 * one requested is refused rather than linked from this PR.
 */
function parseShare(body: unknown, req: PublishRequest): PublishedShare | undefined {
  const share = field(body, "share")
  if (!share || typeof share !== "object") return undefined
  const token = field(share, "token")
  if (typeof token !== "string" || !SHARE_TOKEN.test(token)) return undefined
  const projectId = field(share, "project_id")
  const sessionId = field(share, "session_id")
  if (projectId !== undefined && projectId !== req.projectId) return undefined
  if (sessionId !== undefined && sessionId !== req.sessionId) return undefined

  const out: PublishedShare = { token }
  const expiresAt = field(share, "expires_at")
  if (typeof expiresAt === "string" && !Number.isNaN(Date.parse(expiresAt))) out.expiresAt = expiresAt
  const ceiling = safeCode(field(share, "ceiling"))
  if (ceiling) out.ceiling = ceiling
  const replaced = safeCode(field(body, "replaced_share_id"))
  if (replaced) out.replacedShareId = replaced
  return out
}

/**
 * What the comment and the `publish` / `share-url` outputs report. A skip with
 * `configured: false` (no publish token supplied) adds nothing to the comment, so
 * a workflow that never opted in gets exactly the comment it got before.
 */
export type PublishState =
  | { kind: "published"; reused: boolean; url: string; expiresAt?: string }
  | { kind: "skipped"; reason: PublishSkipReason; configured: boolean; status?: number }

/** The `publish` output: `published`, `reused` or `skipped:<reason>`. */
export function publishOutput(state: PublishState): string {
  if (state.kind === "published") return state.reused ? "reused" : "published"
  return `skipped:${state.reason}`
}

/** `2026-12-10` from an ISO timestamp (UTC), or undefined when absent/invalid. */
export function formatExpiryDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString().slice(0, 10)
}

/** `${console}/s/<token>` — the public post-mortem page the console serves. */
export function buildShareUrl(consoleUrl: string, token: string): string {
  return `${normalizeBaseUrl(consoleUrl)}/s/${encodeURIComponent(token)}`
}

/**
 * The `subject` that keeps one live link per PR: `<host>/<owner>/<repo>/pull/<n>`
 * (`github.com/…` on github.com; the GHES host otherwise). Undefined if it would
 * exceed the contract's 200 characters — the server then reuses per session only.
 */
export function prSubject(serverUrl: string | undefined, owner: string, repo: string, prNumber: number): string | undefined {
  let host = "github.com"
  try {
    if (serverUrl) host = new URL(serverUrl).host || host
  } catch {
    /* keep github.com */
  }
  const subject = `${host}/${owner}/${repo}/pull/${prNumber}`
  return subject.length <= SUBJECT_MAX ? subject : undefined
}

/**
 * The one-line reason the comment shows when no public link was produced, or
 * undefined for `no-token` (no publish token configured: the comment stays
 * exactly as it is without this feature). Fixed copy only — never server text —
 * so nothing from the response is rendered into the PR.
 */
export function publishReasonText(reason: PublishSkipReason, status?: number): string | undefined {
  switch (reason) {
    case "no-token":
      return undefined
    case "fork":
      return "this pull request comes from a fork, and the action never publishes for fork pull requests."
    case "fork-check-failed":
      return "the action could not confirm that this pull request is not from a fork, so it did not publish."
    case "invalid-token":
      return "`machinaut-publish-token` is not a Machinaut CI publish token (those start with `mp_`; a project key cannot publish)."
    case "bad-request":
      return "Machinaut rejected the publish request as malformed."
    case "unauthorized":
      return "Machinaut did not accept the publish token (unknown or revoked)."
    case "quota-exceeded":
      return "the share-link quota for this Machinaut org is used up."
    case "project-scope-conflict":
      return "the publish token is pinned to a different Machinaut project than `project-id`."
    case "not-found":
      return "Machinaut answered 404: the session is not in the publish token's project, or this console does not serve CI publishing yet."
    case "ceiling-above-token":
      return "this session was shipped above the publish token's sensitivity ceiling — ship with `--sensitivity-ceiling public`, or have an owner mint an `internal`-ceiling publish token."
    case "ceiling-unknown":
      return "Machinaut has no recorded sensitivity ceiling for this session (for example, it was shipped before ceilings were recorded), so CI cannot publish it."
    case "session-too-old":
      return "this session was first shipped longer ago than the publish token's freshness window allows."
    case "not-publishable":
      return "Machinaut's publish gate refused this session."
    case "rate-limited":
      return "Machinaut's publish rate limit was reached; a later run can publish."
    case "api-error":
      return `Machinaut's publish endpoint returned an error${status ? ` (HTTP ${status})` : ""}.`
    case "network-error":
      return "Machinaut's publish endpoint could not be reached."
    case "bad-response":
      return "Machinaut's publish response could not be read."
  }
}

/** Replace every occurrence of the publish token with `***`. */
export function redact(text: string, secret: string): string {
  if (!secret) return text
  return text.split(secret).join("***")
}

function oneLine(value: unknown, secret: string): string {
  if (typeof value !== "string") return ""
  const flat = redact(value, secret).replace(/\s+/g, " ").trim()
  return flat.length > 300 ? `${flat.slice(0, 297)}...` : flat
}

function field(obj: unknown, key: string): unknown {
  return obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined
}

/** A server-supplied identifier, accepted only if it is a short plain token. */
function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
