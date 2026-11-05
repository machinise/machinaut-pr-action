import type { SerializedBundle } from "@actions/attest"
import { normalizeBaseUrl } from "./machinaut"

/**
 * Hand the signed bundle to Machinaut's attestation intake (Track G, slice G2 —
 * beta): `POST {api-url}/v1/projects/:p/sessions/:s/attestations`, project key,
 * body = the Sigstore bundle exactly as signing produced it.
 *
 * Display only, never authority. Machinaut verifies on ITS side and labels the
 * result in the console; this action only reports that the upload happened. The
 * signature already verifies without Machinaut (`gh attestation verify`), so the
 * outcome here never changes the gate decision and never fails the step.
 */
export interface IntakeRequest {
  apiUrl: string
  apiKey: string
  projectId: string
  sessionId: string
  bundle: SerializedBundle
}

export type IntakeOutcome = "recorded" | "not_available" | "rejected" | "failed"

export interface IntakeResult {
  outcome: IntakeOutcome
  /** HTTP status (0 = network failure / timeout). */
  status: number
  /** Server error code for `rejected`, when the body carried one. */
  code?: string
  /** One log line. */
  message: string
}

export const BUNDLE_CONTENT_TYPE = "application/vnd.dev.sigstore.bundle.v0.3+json"
export const INTAKE_TIMEOUT_MS = 15_000

interface Raw {
  status: number
  body?: unknown
  networkError?: string
}

export async function submitBundleToIntake(
  req: IntakeRequest,
  deps: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<IntakeResult> {
  try {
    return await submit(req, deps)
  } catch (err) {
    // Belt and braces: this function must never throw into the gate run.
    return { outcome: "failed", status: 0, message: `Machinaut attestation intake failed: ${errMessage(err)}` }
  }
}

async function submit(req: IntakeRequest, deps: { fetch?: typeof fetch; timeoutMs?: number }): Promise<IntakeResult> {
  const url =
    `${normalizeBaseUrl(req.apiUrl)}/v1/projects/${encodeURIComponent(req.projectId)}` +
    `/sessions/${encodeURIComponent(req.sessionId)}/attestations`
  const body = JSON.stringify(req.bundle)
  const doFetch = deps.fetch ?? fetch
  const timeoutMs = deps.timeoutMs ?? INTAKE_TIMEOUT_MS

  const post = async (contentType: string): Promise<Raw> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${req.apiKey}`,
          "content-type": contentType,
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

  let raw = await post(BUNDLE_CONTENT_TYPE)
  if (raw.networkError !== undefined) raw = await post(BUNDLE_CONTENT_TYPE) // one retry, network errors only
  if (raw.status === 415) raw = await post("application/json")
  return classify(raw)
}

function classify(raw: Raw): IntakeResult {
  const { status } = raw
  const code = errorCode(raw.body)
  if (raw.networkError !== undefined) {
    return { outcome: "failed", status: 0, message: `Machinaut attestation intake unreachable: ${raw.networkError}` }
  }
  if (status === 200 || status === 201) {
    return { outcome: "recorded", status, message: "Machinaut recorded the signed attestation (it verifies and labels it in the console)" }
  }
  if (status === 404) {
    return {
      outcome: "not_available",
      status,
      message: "this Machinaut console does not have the attestation intake yet — the bundle was not recorded there",
    }
  }
  if (status === 401 || status === 403) {
    return {
      outcome: "rejected",
      status,
      code: code ?? `http_${status}`,
      message: `Machinaut rejected the attestation upload (${status}) — the project key may lack access to this project`,
    }
  }
  if (status === 409 || status === 413) {
    return {
      outcome: "rejected",
      status,
      code: code ?? `http_${status}`,
      message: `Machinaut rejected the attestation upload (${status}, ${code ?? `http_${status}`})`,
    }
  }
  return { outcome: "failed", status, message: `Machinaut attestation intake failed (HTTP ${status})` }
}

function errorCode(body: unknown): string | undefined {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error?: unknown }).error
    if (typeof e === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(e)) return e
  }
  return undefined
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** What the sticky comment reports about the upload. */
export type IntakeState =
  | { kind: "recorded" }
  | { kind: "not_available" }
  | { kind: "rejected"; reason: string }
  | { kind: "failed"; status: number }
  | { kind: "not_attempted"; why: "dry-run" | "unsigned" | "post-attestation-false" }

export function intakeState(r: IntakeResult): IntakeState {
  switch (r.outcome) {
    case "recorded":
      return { kind: "recorded" }
    case "not_available":
      return { kind: "not_available" }
    case "rejected":
      return { kind: "rejected", reason: r.code ?? `http_${r.status}` }
    case "failed":
      return { kind: "failed", status: r.status }
  }
}
