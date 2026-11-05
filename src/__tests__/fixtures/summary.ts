import type { GovernanceSummary } from "../../governance"
import passFixture from "./governance-summary.pass.json"

/** A deep copy of the §2.2-shaped pass fixture, as a raw API body. */
export function rawSummary(): Record<string, any> {
  return structuredClone(passFixture) as Record<string, any>
}

/**
 * The same fixture as the parsed summary: G0's real body, minus the top-level
 * `beta` candor label (ignored by the parser; never carried into the predicate).
 */
export function summary(): GovernanceSummary {
  const { beta: _beta, ...rest } = rawSummary()
  return rest as GovernanceSummary
}

export const EXPECTED = { projectId: "demo", sessionId: "sess-demo" }

export const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567"
