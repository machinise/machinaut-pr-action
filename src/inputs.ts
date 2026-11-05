import * as core from "@actions/core"
import type { SentinelSeverity } from "./governance"

export type Mode = "comment" | "gate"

/** The repo's gate policy (plan §2.2 `gate.policy`, D5 defaults). Written by the
 *  action into the signed statement — Machinaut never supplies or sees a verdict. */
export interface GatePolicy {
  /** Every hold must be `granted|denied` with `evidence: host_record`. Default true. */
  requireHoldsResolved: boolean
  /** Every granted hold must carry an ADR-0042 `action_representation_hash`. Default false. */
  requireBoundApprovals: boolean
  /** Highest sentinel severity tolerated. Default `warning` (any `critical` fails). */
  maxSentinelSeverity: SentinelSeverity
  /**
   * Records the shipper withheld (below the `secret` ceiling) cannot be evaluated.
   * Default false: fail CLOSED — unreadable approval requests fail the hold rules,
   * unreadable sentinel alerts fail the sentinel rule. True downgrades both to a
   * stated reason that does not fail the gate.
   */
  allowUnreadable: boolean
}

export interface Inputs {
  apiKey: string
  projectId: string
  sessionId: string
  apiUrl: string
  consoleUrl: string
  githubToken: string
  failOnError: boolean
  mode: Mode
  /** Gate-mode only; parsed (and validated) only when `mode: gate`. */
  policy: GatePolicy
  dryRun: boolean
  /** Gate-mode only: POST the signed bundle to Machinaut's attestation intake. Default true. */
  postAttestation: boolean
}

/** YAML 1.2 core-schema booleans — the exact set `core.getBooleanInput` accepts. */
const TRUE_VALUES = ["true", "True", "TRUE"]
const FALSE_VALUES = ["false", "False", "FALSE"]

/**
 * `core.getBooleanInput` semantics, but with an explicit fallback for an EMPTY
 * input (getBooleanInput throws on ''). Used for `fail-on-error`, whose default is
 * mode-dependent: comment mode keeps v1's `false`, gate mode fails closed (`true`).
 */
export function parseBooleanInput(name: string, raw: string, fallback: boolean): boolean {
  const value = raw.trim()
  if (value === "") return fallback
  if (TRUE_VALUES.includes(value)) return true
  if (FALSE_VALUES.includes(value)) return false
  throw new TypeError(
    `Input does not meet YAML 1.2 "Core Schema" specification: ${name}\n` +
      "Support boolean input list: `true | True | TRUE | false | False | FALSE`",
  )
}

export function parseMode(raw: string): Mode {
  const value = raw.trim().toLowerCase()
  if (value === "" || value === "comment") return "comment"
  if (value === "gate") return "gate"
  throw new TypeError(`Input 'mode' must be 'comment' or 'gate', got '${raw}'`)
}

export function parseSeverity(raw: string): SentinelSeverity {
  const value = raw.trim().toLowerCase()
  if (value === "") return "warning"
  if (value === "info" || value === "warning" || value === "critical") return value
  throw new TypeError(`Input 'max-sentinel-severity' must be 'info', 'warning' or 'critical', got '${raw}'`)
}

/** Read and normalise the action inputs. `console-url` falls back to `api-url`. */
export function readInputs(): Inputs {
  const apiUrl = core.getInput("api-url").trim() || "https://console.machinaut.ai"
  const consoleUrl = core.getInput("console-url").trim() || apiUrl
  const mode = parseMode(core.getInput("mode"))
  const gate = mode === "gate"
  return {
    apiKey: core.getInput("machinaut-api-key").trim(),
    projectId: core.getInput("project-id").trim(),
    sessionId: core.getInput("session-id").trim(),
    apiUrl,
    consoleUrl,
    githubToken: core.getInput("github-token").trim(),
    // Comment mode: v1's default (`false`) — a non-critical evidence comment never
    // red-Xes a PR. Gate mode: fail CLOSED by default — a required check that could
    // not fetch the facts or produce its attestation must not go green.
    failOnError: parseBooleanInput("fail-on-error", core.getInput("fail-on-error"), gate),
    mode,
    policy: {
      requireHoldsResolved: gate
        ? parseBooleanInput("require-holds-resolved", core.getInput("require-holds-resolved"), true)
        : true,
      requireBoundApprovals: gate
        ? parseBooleanInput("require-bound-approvals", core.getInput("require-bound-approvals"), false)
        : false,
      maxSentinelSeverity: gate ? parseSeverity(core.getInput("max-sentinel-severity")) : "warning",
      allowUnreadable: gate ? parseBooleanInput("allow-unreadable", core.getInput("allow-unreadable"), false) : false,
    },
    dryRun: gate ? parseBooleanInput("dry-run", core.getInput("dry-run"), false) : false,
    postAttestation: gate ? parseBooleanInput("post-attestation", core.getInput("post-attestation"), true) : true,
  }
}
