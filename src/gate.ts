import type { GovernanceSummary, Hold, SentinelSeverity } from "./governance"
import type { GatePolicy } from "./inputs"

/**
 * The repo's gate decision — computed HERE, in the customer's CI, from the facts
 * Machinaut served. Machinaut never emits "mergeable" (plan §2.1): this pure
 * function is the only place a pass/fail is decided, and its inputs are the
 * repo's own policy inputs.
 */
export type Decision = "pass" | "fail"

export interface GateResult {
  decision: Decision
  /** Everything the statement records about the decision, in order: the
   *  {@link failures} first, then the {@link notes}. Ids and counts only — never
   *  payloads, prompts, or approval reason text (they land in a public log). */
  reasons: string[]
  /** Why the gate failed (empty on pass). */
  failures: string[]
  /** Stated, non-failing caveats — what the policy explicitly allowed to go
   *  unevaluated (`allow-unreadable: true`). */
  notes: string[]
}

/** The policy as recorded in the predicate (`gate.policy`, plan §2.2). */
export interface PredicatePolicy {
  require_holds_resolved: boolean
  require_bound_approvals: boolean
  max_sentinel_severity: SentinelSeverity
  allow_unreadable: boolean
}

export function predicatePolicy(policy: GatePolicy): PredicatePolicy {
  return {
    require_holds_resolved: policy.requireHoldsResolved,
    require_bound_approvals: policy.requireBoundApprovals,
    max_sentinel_severity: policy.maxSentinelSeverity,
    allow_unreadable: policy.allowUnreadable,
  }
}

const SEVERITY_RANK: Record<SentinelSeverity, number> = { info: 0, warning: 1, critical: 2 }
const SEVERITIES: SentinelSeverity[] = ["info", "warning", "critical"]

/** Per-rule cap on per-hold reasons, so a session with hundreds of holds cannot
 *  produce an unbounded predicate / comment. The overflow is summarised. */
export const MAX_HOLD_REASONS = 20

/**
 * Evaluate the summary against the repo's policy (plan D5 defaults):
 *  - `require-holds-resolved` (default true): every hold is `granted|denied` AND
 *    backed by a `host_record`. `relay_only` (Machinaut saw a resolution but the
 *    customer's kernel shipped no record) and `unavailable` count as UNRESOLVED.
 *  - `require-bound-approvals` (default false): every granted hold carries an
 *    ADR-0042 `action_representation_hash`.
 *  - `max-sentinel-severity` (default `warning`): any sentinel above it fails.
 *
 * Fail CLOSED on what cannot be seen: when a hold rule is on, a truncated hold
 * list fails it, and so do approval requests the shipper withheld (below the
 * `secret` ceiling); when the sentinel rule can fail at all, withheld sentinel
 * alerts fail it — a withheld critical alert would otherwise read as
 * `critical: 0`. `allow-unreadable: true` downgrades the two unreadable cases (not
 * truncation) to a stated note that does not fail the gate.
 */
export function evaluateGate(summary: GovernanceSummary, policy: GatePolicy): GateResult {
  const failures: string[] = []
  const notes: string[] = []
  const holdRuleOn = policy.requireHoldsResolved || policy.requireBoundApprovals

  if (policy.requireHoldsResolved) {
    const unresolved = summary.holds.filter((h) => !isResolvedByHost(h))
    pushCapped(failures, unresolved.map(unresolvedReason), (n) => `…and ${n} more hold(s) not resolved by a host record`)
  }

  if (policy.requireBoundApprovals) {
    const unbound = summary.holds.filter((h) => h.outcome === "granted" && !h.action_representation_hash)
    pushCapped(
      failures,
      unbound.map(
        (h) =>
          `hold ${h.request_id}: granted without an ADR-0042 action binding ` +
          "(no action_representation_hash; require-bound-approvals is true)",
      ),
      (n) => `…and ${n} more granted hold(s) without an action binding`,
    )
  }

  if (holdRuleOn && summary.holds_truncated) {
    failures.push("hold list truncated; cannot evaluate every hold")
  }

  const unreadableApprovals = summary.unreadable.approval_requests
  if (holdRuleOn && unreadableApprovals > 0) {
    const what =
      `${unreadableApprovals} approval request${unreadableApprovals === 1 ? "" : "s"} unreadable ` +
      "(withheld by the shipper below the secret ceiling)"
    if (policy.allowUnreadable) notes.push(`${what} — not evaluated; allowed by allow-unreadable`)
    else failures.push(`${what}; cannot evaluate every hold`)
  }

  const max = SEVERITY_RANK[policy.maxSentinelSeverity]
  for (const severity of SEVERITIES) {
    const n = summary.sentinels[severity]
    if (SEVERITY_RANK[severity] > max && n > 0) {
      failures.push(
        `${n} ${severity} sentinel${n === 1 ? "" : "s"} fired ` +
          `(max-sentinel-severity is ${policy.maxSentinelSeverity})`,
      )
    }
  }

  // Only a policy under which some severity can fail is affected by alerts it cannot see.
  const unreadableAlerts = summary.unreadable.sentinel_alerts
  if (max < SEVERITY_RANK.critical && unreadableAlerts > 0) {
    const what =
      `${unreadableAlerts} sentinel alert${unreadableAlerts === 1 ? "" : "s"} unreadable ` +
      "(withheld by the shipper below the secret ceiling)"
    if (policy.allowUnreadable) notes.push(`${what} — severity not evaluated; allowed by allow-unreadable`)
    else failures.push(`${what}; a withheld critical alert would read as critical: 0`)
  }

  return { decision: failures.length === 0 ? "pass" : "fail", reasons: [...failures, ...notes], failures, notes }
}

/** A hold is resolved only when the customer's kernel shipped the outcome
 *  (`host_record`) and that outcome is terminal-by-a-human (`granted|denied`). */
export function isResolvedByHost(h: Hold): boolean {
  return h.evidence === "host_record" && (h.outcome === "granted" || h.outcome === "denied")
}

function unresolvedReason(h: Hold): string {
  const base = `hold ${h.request_id}: ${h.outcome}, evidence ${h.evidence}`
  switch (h.evidence) {
    case "relay_only":
      return `${base} — a relayed resolution with no host record is not a verified approval`
    case "unavailable":
      return `${base} — the host record could not be loaded`
    default:
      return `${base} — not granted or denied`
  }
}

function pushCapped(into: string[], items: string[], overflow: (n: number) => string): void {
  into.push(...items.slice(0, MAX_HOLD_REASONS))
  if (items.length > MAX_HOLD_REASONS) into.push(overflow(items.length - MAX_HOLD_REASONS))
}
