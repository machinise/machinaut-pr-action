import { createHash } from "node:crypto"
import type { Decision, PredicatePolicy } from "./gate"
import type { GovernanceSummary } from "./governance"
import { ACTION_REF } from "./version"

/**
 * The in-toto Statement v1 this action signs (plan §2.2, D3).
 *
 * Built field-for-field the way `@actions/attest` builds it
 * (`{_type, subject, predicateType, predicate}`), so the file written to
 * `statement-path` is byte-identical to the payload the toolkit signs.
 */
export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1"
export const PREDICATE_TYPE = "https://machinaut.ai/attestation/governed-run/v1"

/** File name of the evidence-document subject (see {@link buildSubjects}). */
export const SUMMARY_SUBJECT_NAME = "machinaut-governance-summary.json"

export interface Subject {
  name: string
  digest: Record<string, string>
}

export interface GatePredicateBlock {
  action: string
  /** GITHUB_ACTION_REF: how the action was actually invoked (tag, branch or bare SHA). Omitted when unset. */
  action_ref?: string
  /** GITHUB_ACTION_REPOSITORY. Omitted when unset. */
  action_repository?: string
  policy: PredicatePolicy
  decision: Decision
  reasons: string[]
}

export type GovernedRunPredicate = GovernanceSummary & { gate: GatePredicateBlock }

export interface Statement {
  _type: typeof STATEMENT_TYPE
  subject: Subject[]
  predicateType: typeof PREDICATE_TYPE
  predicate: GovernedRunPredicate
}

export interface StatementInput {
  owner: string
  repo: string
  /** The PR head commit the gate ran for. */
  headSha: string
  summary: GovernanceSummary
  policy: PredicatePolicy
  decision: Decision
  reasons: string[]
  /** Defaults to this build's `machinise/machinaut-pr-action@v<version>`. */
  actionRef?: string
  /** Invocation facts GitHub provides; not payloads. Either is omitted when absent. */
  actionInvocation?: { ref?: string; repository?: string }
}

/**
 * Canonical JSON: object keys sorted (UTF-16 code-unit order, i.e. plain ASCII
 * order for every key this predicate has), no whitespace. Reproducible by an
 * auditor with `jq -cjS` — see the README's verification recipe.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}

/** The bytes of the evidence-document subject: the canonical summary. */
export function summaryDocument(summary: GovernanceSummary): string {
  return canonicalJson(summary)
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex")
}

/**
 * Subjects, in a fixed order:
 *  1. **The PR head commit** — `{name: "<owner>/<repo>", digest: {gitCommit}}` (D3).
 *     This is what the gate is about.
 *  2. **The evidence document the gate evaluated** — sha256 of the canonical
 *     governance summary, written next to the bundle as
 *     `machinaut-governance-summary.json`. GitHub's attestation store and
 *     `gh attestation verify` look attestations up by an artifact's sha256 and
 *     cannot match a `gitCommit`-only subject, so this second subject is what
 *     lets `gh attestation verify <summary file> --repo … --predicate-type …`
 *     work with no Machinaut involvement. It adds no new data: the same summary
 *     is the predicate (minus `gate`).
 */
export function buildSubjects(input: Pick<StatementInput, "owner" | "repo" | "headSha" | "summary">): Subject[] {
  return [
    { name: `${input.owner}/${input.repo}`, digest: { gitCommit: input.headSha } },
    { name: SUMMARY_SUBJECT_NAME, digest: { sha256: sha256Hex(summaryDocument(input.summary)) } },
  ]
}

/**
 * Build the governed-run Statement. Pure and deterministic: the same input
 * always serialises to the same bytes (key order is fixed by construction).
 *
 * The predicate is the summary (already projected onto the frozen
 * `governance_summary@1` shape by `parseGovernanceSummary`) plus the `gate`
 * block this action wrote. {@link assertPredicatePrivacy} re-checks, at runtime,
 * that nothing outside that shape slipped in.
 */
export function buildStatement(input: StatementInput): Statement {
  const { summary } = input
  const predicate: GovernedRunPredicate = {
    machinaut: summary.machinaut,
    chain: summary.chain,
    holds: summary.holds,
    holds_truncated: summary.holds_truncated,
    sentinels: summary.sentinels,
    unreadable: summary.unreadable,
    gate: {
      action: input.actionRef ?? ACTION_REF,
      ...(input.actionInvocation?.ref ? { action_ref: input.actionInvocation.ref } : {}),
      ...(input.actionInvocation?.repository ? { action_repository: input.actionInvocation.repository } : {}),
      policy: input.policy,
      decision: input.decision,
      reasons: input.reasons,
    },
  }
  assertPredicatePrivacy(predicate)
  return {
    _type: STATEMENT_TYPE,
    subject: buildSubjects(input),
    predicateType: PREDICATE_TYPE,
    predicate,
  }
}

/** Every key the predicate may carry. The statement is published to a public
 *  transparency log, so anything else — a payload, a prompt, an approver's reason
 *  text, an actor name — is a bug, and signing must stop. */
const ALLOWED_PREDICATE_KEYS = new Set([
  // machinaut
  "machinaut", "console", "project_id", "session_id", "summary_version", "as_of",
  // chain
  "chain", "events", "readable", "redacted_commitments", "chain_digest", "first_seq", "last_seq",
  // holds
  "holds", "request_id", "action_representation_hash", "outcome", "evidence", "quorum", "k", "m", "record_digest",
  "holds_truncated",
  // sentinels
  "sentinels", "info", "warning", "critical",
  // what the shipper withheld (counts only)
  "unreadable", "approval_requests", "sentinel_alerts",
  // gate (written by this action)
  "gate", "action", "action_ref", "action_repository", "policy", "require_holds_resolved", "require_bound_approvals", "max_sentinel_severity",
  "allow_unreadable", "decision", "reasons",
])

export class PredicatePrivacyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PredicatePrivacyError"
  }
}

export function assertPredicatePrivacy(predicate: unknown, path = "predicate"): void {
  if (Array.isArray(predicate)) {
    predicate.forEach((v, i) => assertPredicatePrivacy(v, `${path}[${i}]`))
    return
  }
  if (predicate !== null && typeof predicate === "object") {
    for (const [k, v] of Object.entries(predicate as Record<string, unknown>)) {
      if (!ALLOWED_PREDICATE_KEYS.has(k)) {
        throw new PredicatePrivacyError(`refusing to sign: ${path}.${k} is not a governed-run/v1 predicate field`)
      }
      assertPredicatePrivacy(v, `${path}.${k}`)
    }
  }
}
