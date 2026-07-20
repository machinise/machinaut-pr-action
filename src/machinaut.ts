import type { WireProjection } from "./projection"

/**
 * The read-only slice of the Machinaut API this action touches.
 *
 * Increment 1 is deliberately read-only (plan §3): the project key CI already
 * holds can READ a session's chain + report, but a machine credential cannot
 * MINT a public share by design (`src/auth/apiKey.ts:188-197`). So we call
 * exactly one endpoint and never a write route.
 */

/** Shape of `GET /v1/projects/:p/sessions/:s?report=1` (`src/explorer/routes.ts`). */
export interface SessionReport {
  projection: WireProjection
  /** OSS `renderReport` markdown — display-only, non-contractual. Quote, never parse. */
  report_markdown?: string
}

/** A non-2xx response from the API, carrying the status so the caller can decide
 *  whether it's fatal (401/403 — misconfigured credential) or skippable (404 —
 *  no such session for this project/tenant). */
export class MachinautApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "MachinautApiError"
  }
}

/** Strip trailing slashes so `${base}/v1/...` never doubles up. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "")
  const u = new URL(trimmed) // throws on a non-absolute / invalid URL — surfaced by the caller
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`api-url must be an http(s) URL, got '${raw}'`)
  }
  return trimmed
}

/**
 * Fetch a session's projection + report markdown with the project key.
 *
 * Uses `Authorization: Bearer <key>` (the machine-credential path in
 * `authenticate()`), `report=1` to opt into the display markdown, and a bounded
 * timeout so a hung control plane can't wedge the job. Path segments are
 * percent-encoded.
 */
export async function fetchSessionReport(
  opts: {
    apiUrl: string
    apiKey: string
    projectId: string
    sessionId: string
  },
  deps: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<SessionReport> {
  const doFetch = deps.fetch ?? fetch
  const timeoutMs = deps.timeoutMs ?? 15_000
  const base = normalizeBaseUrl(opts.apiUrl)
  const path = `/v1/projects/${encodeURIComponent(opts.projectId)}/sessions/${encodeURIComponent(
    opts.sessionId,
  )}?report=1`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await doFetch(`${base}${path}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        accept: "application/json",
        "user-agent": "machinaut-pr-action",
      },
      signal: controller.signal,
    })
  } catch (err) {
    const reason = err instanceof Error && err.name === "AbortError" ? `timed out after ${timeoutMs}ms` : String(err)
    throw new MachinautApiError(0, "network_error", `request to Machinaut failed: ${reason}`)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    // Try to surface the API's structured `{ error, message }` without depending on it.
    let detail = ""
    let code = `http_${res.status}`
    try {
      const body = (await res.json()) as { error?: string; message?: string }
      if (body?.error) code = body.error
      if (body?.message) detail = ` — ${body.message}`
    } catch {
      /* non-JSON error body; the status alone is enough */
    }
    throw new MachinautApiError(res.status, code, `Machinaut returned ${res.status} (${code})${detail}`)
  }

  const body = (await res.json()) as SessionReport
  if (!body || typeof body !== "object" || !body.projection) {
    throw new MachinautApiError(res.status, "unexpected_body", "Machinaut response had no projection")
  }
  return body
}
