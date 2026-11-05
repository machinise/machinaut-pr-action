import { getJson, MachinautApiError } from "./machinaut"

/**
 * The governance summary Machinaut serves per session (Track G, slice G0):
 * `GET /v1/projects/:p/sessions/:s/governance` → `governance_summary@1`.
 *
 * It is everything in the plan §2.2 predicate ABOVE `gate` — digests, ids,
 * enums, counts and timestamps only. The `gate` block (policy, decision,
 * reasons) is written by THIS action, never by Machinaut: Machinaut serves facts,
 * the customer's CI decides and signs (plan §2.1).
 *
 * The hashes inside are Lodestar OSS output (the shipper's `payload_hash`, the
 * kernel's ADR-0042 representation hash, the host's ADR-0041 `QuorumRecord`);
 * Machinaut hosts and summarises them, it does not compute the verification.
 */

export const SUMMARY_VERSION = "governance_summary@1"

export type SentinelSeverity = "info" | "warning" | "critical"
export type HoldOutcome = "granted" | "denied" | "expired" | "unresolved"
/** Who vouches for a hold's outcome: the customer's kernel shipped the record
 *  (`host_record`), Machinaut only saw it pass through the relay (`relay_only` —
 *  unverified by anyone the statement can vouch for), or the evidence could not
 *  be loaded (`unavailable`). */
export type HoldEvidence = "host_record" | "relay_only" | "unavailable"

export interface GovernanceSummary {
  machinaut: {
    console: string
    project_id: string
    session_id: string
    summary_version: typeof SUMMARY_VERSION
    as_of: string
  }
  chain: {
    events: number
    readable: number
    redacted_commitments: number
    chain_digest: string
    first_seq: number | null
    last_seq: number | null
  }
  holds: Hold[]
  /** True when G0 capped `holds[]` (at 50): the list is not every hold. */
  holds_truncated: boolean
  sentinels: Record<SentinelSeverity, number>
  /**
   * Records the shipper withheld (below the `secret` sensitivity ceiling) and
   * Machinaut therefore cannot read: a withheld critical sentinel alert would
   * otherwise read as `critical: 0`. Counts only.
   */
  unreadable: { approval_requests: number; sentinel_alerts: number }
}

export interface Hold {
  request_id: string
  /** ADR-0042 binding, present only when the hold was bound to an action representation. */
  action_representation_hash?: string
  outcome: HoldOutcome
  evidence: HoldEvidence
  /** ADR-0041, present only when the host adjudicated a quorum. */
  quorum?: { k: number; m: number; record_digest: string }
}

/** The response is not a summary this action understands (wrong version, wrong
 *  shape, or not the session we asked for). Always an infrastructure error. */
export class GovernanceSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GovernanceSchemaError"
  }
}

/**
 * A sha256 digest, with or without the `sha256:` prefix. G0 serves prefixed
 * digests (`action_representation_hash` is `sha256:<inputs_hash hex>`); Lodestar's
 * own ADR-0042 `ACTION_REPRESENTATION_HASH_PATTERN` is bare hex, so both are
 * accepted. Either way the field can only ever hold a digest — never free text —
 * which is part of the privacy guarantee for a public transparency log.
 */
const DIGEST = /^(sha256:)?[0-9a-f]{64}$/
/** Opaque ids: bounded and free of control characters / whitespace. */
const ID = /^[^\s\u0000-\u001f\u007f]{1,256}$/
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

const OUTCOMES: readonly HoldOutcome[] = ["granted", "denied", "expired", "unresolved"]
const EVIDENCE: readonly HoldEvidence[] = ["host_record", "relay_only", "unavailable"]

/** Known top-level keys. Anything else the API adds is dropped (and logged by the
 *  caller): the predicate lands in a PUBLIC transparency log, so only fields this
 *  action knows to be digests / ids / counts / enums may be carried into it. */
const KNOWN_TOP_LEVEL = ["machinaut", "chain", "holds", "holds_truncated", "sentinels", "unreadable"]

/** Top-level keys G0 sends that are deliberately NOT carried into the predicate
 *  and need no notice: `beta` is G0's own candor label for the endpoint. */
const IGNORED_TOP_LEVEL = ["beta"]

export interface ParsedSummary {
  summary: GovernanceSummary
  /** Dotted paths of fields present in the response but not carried into the predicate. */
  dropped: string[]
}

/**
 * Validate a raw `/governance` body and project it onto the frozen
 * `governance_summary@1` shape. Throws {@link GovernanceSchemaError} with a
 * human-readable reason on any mismatch — a gate must never evaluate (let alone
 * sign) facts it could not read exactly.
 */
export function parseGovernanceSummary(
  raw: unknown,
  expected: { projectId: string; sessionId: string },
): ParsedSummary {
  const dropped: string[] = []
  const root = obj(raw, "response body")

  const m = obj(root.machinaut, "machinaut")
  const version = m.summary_version
  if (version !== SUMMARY_VERSION) {
    throw new GovernanceSchemaError(
      `unsupported governance summary version ${JSON.stringify(version ?? null)} — this action ` +
        `understands only '${SUMMARY_VERSION}'. Upgrade machinaut-pr-action (or pin a control plane ` +
        `that serves '${SUMMARY_VERSION}').`,
    )
  }
  const machinaut = {
    console: url(m.console, "machinaut.console"),
    project_id: id(m.project_id, "machinaut.project_id"),
    session_id: id(m.session_id, "machinaut.session_id"),
    summary_version: SUMMARY_VERSION,
    as_of: timestamp(m.as_of, "machinaut.as_of"),
  } as const
  noteExtra(m, Object.keys(machinaut), "machinaut", dropped)

  if (machinaut.project_id !== expected.projectId || machinaut.session_id !== expected.sessionId) {
    throw new GovernanceSchemaError(
      `governance summary is for ${machinaut.project_id}/${machinaut.session_id}, ` +
        `but this run asked for ${expected.projectId}/${expected.sessionId}`,
    )
  }

  const c = obj(root.chain, "chain")
  const chain = {
    events: count(c.events, "chain.events"),
    readable: count(c.readable, "chain.readable"),
    redacted_commitments: count(c.redacted_commitments, "chain.redacted_commitments"),
    chain_digest: digest(c.chain_digest, "chain.chain_digest"),
    first_seq: seq(c.first_seq, "chain.first_seq"),
    last_seq: seq(c.last_seq, "chain.last_seq"),
  }
  noteExtra(c, Object.keys(chain), "chain", dropped)

  if (!Array.isArray(root.holds)) throw new GovernanceSchemaError("holds must be an array")
  const holds = root.holds.map((h, i) => parseHold(h, `holds[${i}]`, dropped))
  const holdsTruncated = bool(root.holds_truncated, "holds_truncated")

  const s = obj(root.sentinels, "sentinels")
  const sentinels = {
    info: count(s.info, "sentinels.info"),
    warning: count(s.warning, "sentinels.warning"),
    critical: count(s.critical, "sentinels.critical"),
  }
  noteExtra(s, Object.keys(sentinels), "sentinels", dropped)

  const u = obj(root.unreadable, "unreadable")
  const unreadable = {
    approval_requests: count(u.approval_requests, "unreadable.approval_requests"),
    sentinel_alerts: count(u.sentinel_alerts, "unreadable.sentinel_alerts"),
  }
  noteExtra(u, Object.keys(unreadable), "unreadable", dropped)

  // `gate` is the action's to write. A summary that carries one is still parsed,
  // but its gate is discarded: Machinaut never emits a merge verdict.
  noteExtra(root, [...KNOWN_TOP_LEVEL, ...IGNORED_TOP_LEVEL], "", dropped)

  return {
    summary: { machinaut, chain, holds, holds_truncated: holdsTruncated, sentinels, unreadable },
    dropped,
  }
}

function parseHold(raw: unknown, path: string, dropped: string[]): Hold {
  const h = obj(raw, path)
  const requestId = id(h.request_id, `${path}.request_id`)
  const outcome = oneOf(h.outcome, OUTCOMES, `${path}.outcome`)
  const evidence = oneOf(h.evidence, EVIDENCE, `${path}.evidence`)

  // Keys are inserted in the §2.2 order (optional ones only when present) so the
  // serialised statement is deterministic for a given summary.
  const out: Record<string, unknown> = { request_id: requestId }
  if (h.action_representation_hash !== undefined && h.action_representation_hash !== null) {
    out.action_representation_hash = digest(h.action_representation_hash, `${path}.action_representation_hash`)
  }
  out.outcome = outcome
  out.evidence = evidence
  if (h.quorum !== undefined && h.quorum !== null) {
    const q = obj(h.quorum, `${path}.quorum`)
    out.quorum = {
      k: count(q.k, `${path}.quorum.k`),
      m: count(q.m, `${path}.quorum.m`),
      record_digest: digest(q.record_digest, `${path}.quorum.record_digest`),
    }
    noteExtra(q, ["k", "m", "record_digest"], `${path}.quorum`, dropped)
  }
  noteExtra(h, ["request_id", "action_representation_hash", "outcome", "evidence", "quorum"], path, dropped)
  return out as unknown as Hold
}

/**
 * Fetch and validate the governance summary for one session with the project key.
 * A 404 is NOT skippable here (unlike comment mode): a gate asked to evaluate a
 * session it cannot see must not pass. The caller treats every error from this
 * function as an infrastructure error, governed by `fail-on-error`.
 */
export async function fetchGovernanceSummary(
  opts: { apiUrl: string; apiKey: string; projectId: string; sessionId: string },
  deps: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<ParsedSummary> {
  const path = `/v1/projects/${encodeURIComponent(opts.projectId)}/sessions/${encodeURIComponent(
    opts.sessionId,
  )}/governance`
  let body: unknown
  try {
    ;({ body } = await getJson<unknown>({ apiUrl: opts.apiUrl, apiKey: opts.apiKey, path }, deps))
  } catch (err) {
    if (err instanceof MachinautApiError && err.status === 404) {
      throw new MachinautApiError(
        404,
        err.code,
        `${err.message}. No governance summary for session '${opts.sessionId}' in project ` +
          `'${opts.projectId}' — check the session was shipped, and that your control plane serves ` +
          "GET …/sessions/:s/governance (beta).",
      )
    }
    throw err
  }
  return parseGovernanceSummary(body, { projectId: opts.projectId, sessionId: opts.sessionId })
}

// ── tiny validators ──────────────────────────────────────────────────────────

function obj(v: unknown, path: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new GovernanceSchemaError(`${path} must be an object`)
  }
  return v as Record<string, unknown>
}

function str(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 2048) {
    throw new GovernanceSchemaError(`${path} must be a non-empty string`)
  }
  return v
}

function url(v: unknown, path: string): string {
  const s = str(v, path)
  let parsed: URL
  try {
    parsed = new URL(s)
  } catch {
    throw new GovernanceSchemaError(`${path} must be an absolute http(s) URL`)
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new GovernanceSchemaError(`${path} must be an absolute http(s) URL`)
  }
  return s
}

function id(v: unknown, path: string): string {
  if (typeof v !== "string" || !ID.test(v)) {
    throw new GovernanceSchemaError(`${path} must be an id (1–256 non-whitespace characters)`)
  }
  return v
}

function timestamp(v: unknown, path: string): string {
  if (typeof v !== "string" || !ISO_TIMESTAMP.test(v) || Number.isNaN(Date.parse(v))) {
    throw new GovernanceSchemaError(`${path} must be an ISO-8601 timestamp`)
  }
  return v
}

function digest(v: unknown, path: string): string {
  if (typeof v !== "string" || !DIGEST.test(v)) {
    throw new GovernanceSchemaError(`${path} must be a sha256 digest`)
  }
  return v
}

function count(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new GovernanceSchemaError(`${path} must be a non-negative integer`)
  }
  return v
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") throw new GovernanceSchemaError(`${path} must be a boolean`)
  return v
}

function seq(v: unknown, path: string): number | null {
  if (v === null) return null
  return count(v, path)
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new GovernanceSchemaError(`${path} must be one of ${allowed.join(" | ")}, got ${JSON.stringify(v)}`)
  }
  return v as T
}

function noteExtra(o: Record<string, unknown>, known: string[], prefix: string, dropped: string[]): void {
  for (const k of Object.keys(o)) {
    if (!known.includes(k)) dropped.push(prefix ? `${prefix}.${k}` : k)
  }
}
