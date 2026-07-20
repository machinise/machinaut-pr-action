import * as core from "@actions/core"
import * as github from "@actions/github"
import { renderComment, STICKY_MARKER } from "./comment"
import { type PrPayload, prTargetFromPayload } from "./events"
import { readInputs } from "./inputs"
import { fetchSessionReport, MachinautApiError, normalizeBaseUrl } from "./machinaut"
import { type CommentApi, upsertStickyComment } from "./sticky"

/**
 * Increment 1 (plan §3): authenticate with the consumer's existing project key,
 * read `GET /v1/projects/:p/sessions/:s?report=1`, and post one sticky comment
 * carrying the agent's evidence teaser + a login-walled console deep link.
 *
 * The trigger is "a Lodestar session was shipped for this PR" — signalled by a
 * non-empty `session-id` input (plan D1/D2). No session → clean no-op.
 */
export async function run(): Promise<void> {
  const inputs = readInputs()

  // A missing/empty result means nothing was shipped — the honest "not
  // agent-authored" signal. Skip cleanly, never fail (plan D1: no false positives).
  if (!inputs.sessionId) {
    return skip("no-session", "no session id supplied — nothing was shipped for this run")
  }
  if (!inputs.apiKey) return fail(inputs.failOnError, "no-api-key", "machinaut-api-key is required")
  if (!inputs.projectId) return fail(inputs.failOnError, "no-project-id", "project-id is required")
  if (!inputs.githubToken) return fail(inputs.failOnError, "no-github-token", "github-token is required to comment")

  // The console deep link is honest to publish regardless of what happens next,
  // so compute and surface it early as an output.
  let sessionUrl: string
  try {
    sessionUrl = buildSessionUrl(inputs.consoleUrl, inputs.projectId, inputs.sessionId)
  } catch (err) {
    return fail(inputs.failOnError, "bad-console-url", errMessage(err))
  }
  core.setOutput("session-url", sessionUrl)

  const octokit = github.getOctokit(inputs.githubToken) as unknown as CommentApi
  const { owner, repo } = github.context.repo

  // Resolve the PR to comment on: prefer the event payload, else find the PR the
  // head SHA belongs to (covers push / workflow_run triggers).
  let issueNumber: number
  try {
    const resolved = await resolvePrNumber(octokit)
    if (resolved === undefined) {
      return skip("no-pr", "no pull request is associated with this run — nothing to comment on")
    }
    issueNumber = resolved
  } catch (err) {
    return fail(inputs.failOnError, "pr-lookup-failed", errMessage(err))
  }

  // Read the session's projection + report markdown with the project key.
  let report
  try {
    report = await fetchSessionReport({
      apiUrl: inputs.apiUrl,
      apiKey: inputs.apiKey,
      projectId: inputs.projectId,
      sessionId: inputs.sessionId,
    })
  } catch (err) {
    // A 404 for a supplied session id means there's no evidence to show (a race,
    // a wrong id, or a foreign/tenant-scoped session) — skip rather than red-X.
    if (err instanceof MachinautApiError && err.status === 404) {
      return skip("session-not-found", `Machinaut has no session '${inputs.sessionId}' for project '${inputs.projectId}'`)
    }
    // 401/403 (bad or mis-scoped key) and everything else respect fail-on-error.
    return fail(inputs.failOnError, "api-error", errMessage(err))
  }

  const body = renderComment({ report, sessionUrl })

  try {
    const result = await upsertStickyComment(octokit, {
      owner,
      repo,
      issueNumber,
      marker: STICKY_MARKER,
      body,
    })
    core.setOutput("comment-id", String(result.id))
    core.setOutput("comment-url", result.html_url)
    core.setOutput("status", result.action)
    core.info(`${result.action} evidence comment on ${owner}/${repo}#${issueNumber}: ${result.html_url}`)
  } catch (err) {
    return fail(inputs.failOnError, "comment-failed", errMessage(err))
  }
}

/** `${console}/projects/:p/sessions/:s`, matching the explorer route. */
export function buildSessionUrl(consoleUrl: string, projectId: string, sessionId: string): string {
  const base = normalizeBaseUrl(consoleUrl)
  return `${base}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`
}

/**
 * The PR number for this run: the event payload's PR (pull_request /
 * pull_request_target / issue_comment / workflow_run), else the PR the head
 * commit belongs to (push / merge_group). Returns undefined when there is
 * genuinely no PR to comment on. Payload → target selection is the pure,
 * unit-tested {@link prTargetFromPayload}.
 */
async function resolvePrNumber(octokit: CommentApi): Promise<number | undefined> {
  const ctx = github.context
  const target = prTargetFromPayload(ctx.payload as PrPayload, ctx.sha)
  if (typeof target.prNumber === "number") return target.prNumber
  if (!target.sha) return undefined

  const prs = await octokit
    .paginate<{ number: number; state: string }>(octokit.rest.repos.listPullRequestsAssociatedWithCommit, {
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      commit_sha: target.sha,
      per_page: 100,
    })
    .catch(() => [] as { number: number; state: string }[])

  const open = prs.find((p) => p.state === "open") ?? prs[0]
  return open?.number
}

function skip(reason: string, message: string): void {
  core.setOutput("status", `skipped:${reason}`)
  core.notice(`machinaut-pr-action skipped (${reason}): ${message}`)
}

function fail(failOnError: boolean, reason: string, message: string): void {
  core.setOutput("status", `skipped:${reason}`)
  if (failOnError) {
    core.setFailed(`machinaut-pr-action: ${message}`)
  } else {
    core.warning(`machinaut-pr-action (${reason}): ${message} — continuing (fail-on-error is false)`)
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Entrypoint. Any unexpected throw becomes a warning/failure per fail-on-error;
// but readInputs() can throw before we know that flag, so guard defensively.
run().catch((err) => {
  core.setFailed(`machinaut-pr-action: unexpected error: ${errMessage(err)}`)
})
