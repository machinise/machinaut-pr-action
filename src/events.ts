/**
 * Resolve which PR to comment on from the event payload — pure and unit-tested so
 * the per-trigger source selection can't regress. Kept out of `main.ts` (which has
 * an import-time `run()` side effect) so tests can import it cleanly.
 */

export interface PrPayload {
  pull_request?: { number?: number; head?: { sha?: string } }
  /** issue_comment on a PR carries the PR under `issue`. */
  issue?: { number?: number; pull_request?: unknown }
  /** A completed `workflow_run` carries its own PR list + head SHA. */
  workflow_run?: { head_sha?: string; pull_requests?: { number?: number }[] }
}

/** Either a PR number named directly by the payload, or the head SHA to look its
 *  PR up from (`repos.listPullRequestsAssociatedWithCommit`), or neither. */
export interface PrTarget {
  prNumber?: number
  sha?: string
}

/**
 * Decide the comment target from the event payload alone.
 *
 * Order:
 *  1. `pull_request` / `pull_request_target` — the PR number is right there.
 *  2. `issue_comment` on a PR — the issue *is* the PR.
 *  3. `workflow_run` — the completed run lists the PR(s) it belongs to; use that.
 *  4. A head SHA to look up — from `pull_request.head.sha`, else the
 *     `workflow_run.head_sha`, else `contextSha` (push / merge_group).
 *
 * The `workflow_run` cases are the point of this function: on that trigger
 * `github.context.sha` is the DEFAULT-branch SHA, not the PR head, so using it
 * would look up the wrong PR (or none). We prefer the run's own PR list / head_sha
 * and only fall back to `contextSha` for triggers where it is the right commit.
 */
export function prTargetFromPayload(payload: PrPayload, contextSha: string | undefined): PrTarget {
  const fromPr = payload.pull_request?.number
  if (typeof fromPr === "number") return { prNumber: fromPr }

  if (payload.issue?.pull_request && typeof payload.issue.number === "number") {
    return { prNumber: payload.issue.number }
  }

  const runPr = payload.workflow_run?.pull_requests?.find((p) => typeof p.number === "number")?.number
  if (typeof runPr === "number") return { prNumber: runPr }

  const sha = payload.pull_request?.head?.sha ?? payload.workflow_run?.head_sha ?? contextSha
  return sha ? { sha } : {}
}
