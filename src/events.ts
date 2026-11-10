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
 * Events on which `github.context.sha` is genuinely the PR/branch head commit,
 * so looking a PR up from it is sound. On every OTHER event (`issue_comment` on a
 * plain issue, `workflow_dispatch`, `schedule`, …) `context.sha` is the
 * default-branch commit — using it could resolve an *unrelated* PR (e.g. one whose
 * head happens to be the branch tip) and post the evidence comment there. So the
 * bare-`contextSha` fallback is limited to this set; other events skip instead.
 */
const CONTEXT_SHA_EVENTS = new Set(["push", "merge_group"])

/**
 * Decide the comment target from the event payload alone.
 *
 * Order:
 *  1. `pull_request` / `pull_request_target` — the PR number is right there.
 *  2. `issue_comment` on a PR — the issue *is* the PR.
 *  3. `workflow_run` — the completed run lists the PR(s) it belongs to; use that.
 *  4. A trustworthy head SHA to look up — `pull_request.head.sha` or
 *     `workflow_run.head_sha` (always a real head), else `contextSha` but ONLY on
 *     events where it is the head commit ({@link CONTEXT_SHA_EVENTS}).
 *
 * The SHA-source discipline is the point of this function: on `workflow_run` and
 * on non-PR events `github.context.sha` is the DEFAULT-branch SHA, so using it
 * unconditionally would look up the wrong PR (or none). We prefer the payload's
 * own head SHA and gate the bare `contextSha` fallback by event type.
 */
export function prTargetFromPayload(
  payload: PrPayload,
  contextSha: string | undefined,
  eventName: string | undefined,
): PrTarget {
  const fromPr = payload.pull_request?.number
  if (typeof fromPr === "number") return { prNumber: fromPr }

  if (payload.issue?.pull_request && typeof payload.issue.number === "number") {
    return { prNumber: payload.issue.number }
  }

  const runPr = payload.workflow_run?.pull_requests?.find((p) => typeof p.number === "number")?.number
  if (typeof runPr === "number") return { prNumber: runPr }

  // A head SHA from the payload is always a real PR/branch head; the bare
  // context SHA is only trustworthy on the events above.
  const headSha = payload.pull_request?.head?.sha ?? payload.workflow_run?.head_sha
  const gatedContextSha = eventName !== undefined && CONTEXT_SHA_EVENTS.has(eventName) ? contextSha : undefined
  const sha = headSha ?? gatedContextSha
  return sha ? { sha } : {}
}

/** The minimal Octokit surface {@link findPrNumberForSha} needs. */
export interface PrLister {
  paginate: <T>(route: unknown, params: Record<string, unknown>) => Promise<T[]>
  rest: { repos: { listPullRequestsAssociatedWithCommit: unknown } }
}

/**
 * Look up the PR a commit belongs to (the open one, else the first).
 *
 * Deliberately does NOT swallow API errors: a real failure — bad/insufficient
 * token, rate limit, GitHub outage — must surface to the caller's
 * `pr-lookup-failed` handler (and honour `fail-on-error`), not masquerade as
 * "no PR" and silently skip. A commit genuinely on no PR is not an error — the
 * API returns an empty list, which maps to `undefined` here.
 */
export async function findPrNumberForSha(
  octokit: PrLister,
  args: { owner: string; repo: string; sha: string },
): Promise<number | undefined> {
  const prs = await octokit.paginate<{ number: number; state: string }>(
    octokit.rest.repos.listPullRequestsAssociatedWithCommit,
    { owner: args.owner, repo: args.repo, commit_sha: args.sha, per_page: 100 },
  )
  const open = prs.find((p) => p.state === "open") ?? prs[0]
  return open?.number
}

/**
 * Gate mode: the PR head commit the governed-run statement is about (its
 * `gitCommit` subject, plan D3). Same SHA-source discipline as
 * {@link prTargetFromPayload}: the payload's own head SHA first
 * (`pull_request.head.sha`, `workflow_run.head_sha`), else `contextSha` only on
 * events where it IS the head ({@link CONTEXT_SHA_EVENTS}). Returns undefined
 * when the payload cannot say (e.g. `issue_comment`) — the caller then reads the
 * PR's head from the API.
 */
export function headShaFromPayload(
  payload: PrPayload,
  contextSha: string | undefined,
  eventName: string | undefined,
): string | undefined {
  const fromPayload = payload.pull_request?.head?.sha ?? payload.workflow_run?.head_sha
  if (fromPayload) return fromPayload
  return eventName !== undefined && CONTEXT_SHA_EVENTS.has(eventName) && contextSha ? contextSha : undefined
}

/** The fork-relevant slice of a `pull_request` payload. */
export interface ForkPayload {
  pull_request?: {
    head?: { repo?: { full_name?: string } | null }
    base?: { repo?: { full_name?: string } | null }
  }
}

/** The repo slices fork detection for PUBLISHING compares, on every event that carries them. */
export interface ForkHeadPayload {
  pull_request?: {
    head?: { repo?: { full_name?: string } | null }
    base?: { repo?: { full_name?: string } | null }
  }
  workflow_run?: {
    head_repository?: { full_name?: string } | null
    repository?: { full_name?: string } | null
  }
}

/**
 * Publishing (ADR-0002 decision 19): does this run's PR head come from a fork,
 * judged from the payload alone?
 *
 * Unlike {@link isForkPullRequest} (which answers "can this run sign?"), this looks
 * at EVERY event that carries the repos — `pull_request_target` and `workflow_run`
 * included — because a public link must never be minted for a fork's PR, whatever
 * credential the run happens to hold. That is what keeps the two unsupported
 * patterns (`pull_request_target` over fork code, `workflow_run` over a fork's
 * artifacts) from publishing even when the base repo's secrets are present.
 *
 * `true` = a fork (or a deleted head repo), `false` = the payload's own
 * `pull_request` is from the same repo, `undefined` = the payload cannot rule a
 * fork out (e.g. `issue_comment`, `push`, `workflow_run`): the caller asks the
 * API about the PR it is publishing for, or refuses to publish.
 *
 * A `workflow_run` payload describes the TRIGGERING run, not necessarily the PR
 * this action resolves: a run that followed a base-context `pull_request_target`
 * run has `head_repository == repository` even when its PR comes from a fork. So
 * `workflow_run` can prove a fork but never rules one out.
 */
export function forkHeadFromPayload(payload: ForkHeadPayload): boolean | undefined {
  const pr = payload.pull_request
  if (pr) {
    if (pr.head?.repo === null) return true // the fork was deleted
    return headDiffersFromBase(pr.head?.repo?.full_name, pr.base?.repo?.full_name)
  }
  const run = payload.workflow_run
  if (run) {
    if (run.head_repository === null) return true
    return headDiffersFromBase(run.head_repository?.full_name, run.repository?.full_name) === true ? true : undefined
  }
  return undefined
}

/** `true` when the head repo is not the base repo; `undefined` when either name is missing. */
export function headDiffersFromBase(head: string | undefined, base: string | undefined): boolean | undefined {
  if (!head || !base) return undefined
  return head.toLowerCase() !== base.toLowerCase()
}

/**
 * Whether this run is a `pull_request`-family event from a fork. GitHub withholds
 * repository secrets and OIDC tokens from such runs, so the gate cannot sign.
 * (`pull_request_target` runs in the base repo's context and is NOT restricted.)
 * A PR whose head repo is gone (`null` — a deleted fork) is treated as a fork.
 */
export function isForkPullRequest(payload: ForkPayload, eventName: string | undefined): boolean {
  if (eventName === undefined || !eventName.startsWith("pull_request") || eventName === "pull_request_target") {
    return false
  }
  const pr = payload.pull_request
  if (!pr) return false
  if (pr.head?.repo === null) return true // the fork was deleted
  const head = pr.head?.repo?.full_name
  const base = pr.base?.repo?.full_name
  if (!head || !base) return false
  return head.toLowerCase() !== base.toLowerCase()
}
