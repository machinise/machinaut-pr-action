import { renderComment, STICKY_MARKER } from "./comment"
import { findPrNumberForSha, forkHeadFromPayload, headDiffersFromBase, type PrPayload, prTargetFromPayload } from "./events"
import type { ActionsCore, GateContext } from "./gateRun"
import type { Inputs } from "./inputs"
import { fetchSessionReport, MachinautApiError, normalizeBaseUrl } from "./machinaut"
import {
  buildShareUrl,
  PUBLISH_TOKEN_PREFIX,
  publishOutput,
  publishReasonText,
  publishShare,
  type PublishSkipReason,
  type PublishState,
  prSubject,
} from "./publish"
import { type CommentApi, upsertStickyComment } from "./sticky"

type SkippedPublish = Extract<PublishState, { kind: "skipped" }>

/**
 * Comment mode.
 *
 * Increment 1 (plan §3): authenticate with the consumer's existing project key,
 * read `GET /v1/projects/:p/sessions/:s?report=1`, and post one sticky comment
 * carrying the agent's evidence teaser + a login-walled console deep link.
 *
 * Increment 2 (ADR-0002 — planned): when the separate CI publish token is
 * supplied and the PR is not from a fork, also mint (or reuse) a public,
 * expiring `/s/:token` link and lead the comment with it. Any publish problem
 * degrades to the Increment 1 link plus a one-line reason; it never fails the step.
 *
 * The trigger is "a Lodestar session was shipped for this PR" — signalled by a
 * non-empty `session-id` input (plan D1/D2). No session → clean no-op.
 */

/** The PR's head and base repos — the fork check when the payload cannot say. */
export interface PullRepos {
  head: { repo: { full_name?: string } | null }
  base: { repo: { full_name?: string } | null }
}

/** Octokit, narrowed to what comment mode calls: comments, PR lookup, and (publishing only) the PR's repos. */
export interface CommentGitHubApi extends CommentApi {
  rest: CommentApi["rest"] & {
    pulls: {
      get: (params: { owner: string; repo: string; pull_number: number }) => Promise<{ data: PullRepos }>
    }
  }
}

export interface CommentDeps {
  core: ActionsCore
  context: GateContext
  /** Lazily built so a missing token is reported as an input error, not a crash. */
  octokit: () => CommentGitHubApi
  fetch?: typeof fetch
}

export async function runComment(inputs: Inputs, deps: CommentDeps): Promise<void> {
  const { core, context } = deps

  const skip = (reason: string, message: string): void => {
    core.setOutput("status", `skipped:${reason}`)
    core.notice(`machinaut-pr-action skipped (${reason}): ${message}`)
  }
  const fail = (reason: string, message: string): void => {
    core.setOutput("status", `skipped:${reason}`)
    if (inputs.failOnError) {
      core.setFailed(`machinaut-pr-action: ${message}`)
    } else {
      core.warning(`machinaut-pr-action (${reason}): ${message} — continuing (fail-on-error is false)`)
    }
  }

  // A missing/empty result means nothing was shipped — the honest "not
  // agent-authored" signal. Skip cleanly, never fail (plan D1: no false positives).
  if (!inputs.sessionId) {
    return skip("no-session", "no session id supplied — nothing was shipped for this run")
  }
  if (!inputs.apiKey) return fail("no-api-key", "machinaut-api-key is required")
  if (!inputs.projectId) return fail("no-project-id", "project-id is required")
  if (!inputs.githubToken) return fail("no-github-token", "github-token is required to comment")

  // The console deep link is honest to publish regardless of what happens next,
  // so compute and surface it early as an output.
  let sessionUrl: string
  try {
    sessionUrl = buildSessionUrl(inputs.consoleUrl, inputs.projectId, inputs.sessionId)
  } catch (err) {
    return fail("bad-console-url", errMessage(err))
  }
  core.setOutput("session-url", sessionUrl)

  const octokit = deps.octokit()
  const { owner, repo } = context.repo

  // Resolve the PR to comment on: prefer the event payload, else find the PR the
  // head SHA belongs to (covers push / workflow_run triggers).
  let issueNumber: number
  try {
    const resolved = await resolvePrNumber(octokit, context)
    if (resolved === undefined) {
      return skip("no-pr", "no pull request is associated with this run — nothing to comment on")
    }
    issueNumber = resolved
  } catch (err) {
    return fail("pr-lookup-failed", errMessage(err))
  }

  // Read the session's projection + report markdown with the project key.
  let report
  try {
    report = await fetchSessionReport(
      {
        apiUrl: inputs.apiUrl,
        apiKey: inputs.apiKey,
        projectId: inputs.projectId,
        sessionId: inputs.sessionId,
      },
      { fetch: deps.fetch },
    )
  } catch (err) {
    // A 404 for a supplied session id means there's no evidence to show (a race,
    // a wrong id, or a foreign/tenant-scoped session) — skip rather than red-X.
    if (err instanceof MachinautApiError && err.status === 404) {
      return skip("session-not-found", `Machinaut has no session '${inputs.sessionId}' for project '${inputs.projectId}'`)
    }
    // 401/403 (bad or mis-scoped key) and everything else respect fail-on-error.
    return fail("api-error", errMessage(err))
  }

  // Public link (planned). Only after the report read succeeded, so a link is
  // never minted for a run that posts no comment. Never throws, never fails the step.
  const publish = await planAndPublish(inputs, deps, octokit, issueNumber)
  core.setOutput("publish", publishOutput(publish))
  core.setOutput("share-url", publish.kind === "published" ? publish.url : "")

  const body = renderComment({ report, sessionUrl, publish })

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
    // Say so when a public link exists that this comment failed to show: it is
    // live (and may have replaced this PR's previous link) until it expires or an
    // owner revokes it.
    const live =
      publish.kind === "published"
        ? ` — note: the public post-mortem link ${publish.url} was ${publish.reused ? "reused" : "published"} and is live, ` +
          "but this comment could not show it"
        : ""
    return fail("comment-failed", `${errMessage(err)}${live}`)
  }
}

/**
 * Decide whether to publish, and do it. Order (ADR-0002 decisions 11, 19, 20):
 *  1. the payload says the PR is from a fork → never publish (whatever token the run holds);
 *  2. no publish token → nothing to do; the comment stays exactly as without the feature;
 *  3. a token that is not a CI publish token (`mp_…`) → refuse locally, send nothing;
 *  4. unless the payload's own pull_request is this PR and is from the same repo,
 *     ask the API about this PR; unsure → do not publish;
 *  5. `POST /v1/publish/shares` → a public link, or a reason.
 * Every outcome is logged; refusals and errors as a warning annotation. None fails the step.
 */
async function planAndPublish(
  inputs: Inputs,
  deps: CommentDeps,
  octokit: CommentGitHubApi,
  prNumber: number,
): Promise<PublishState> {
  const { core, context } = deps
  const token = inputs.publishToken
  const skipped = (reason: PublishSkipReason, status?: number): SkippedPublish => ({
    kind: "skipped",
    reason,
    configured: token !== "",
    status,
  })

  const forkFromPayload = forkHeadFromPayload(context.payload as never)
  if (forkFromPayload === true) {
    if (token) {
      core.notice(
        "machinaut-pr-action publish skipped (fork): this pull request comes from a fork; the action never publishes " +
          "a public link for fork pull requests. The comment links the sign-in-walled console.",
      )
    }
    return skipped("fork")
  }

  if (!token) {
    core.info("no machinaut-publish-token supplied — linking the sign-in-walled console (publish: skipped:no-token)")
    return skipped("no-token")
  }

  const refuse = (state: SkippedPublish, detail: string): PublishState => {
    core.warning(
      `machinaut-pr-action publish (${state.reason}): ${detail} — the comment links the sign-in-walled console ` +
        "instead; the step is not failed for this",
    )
    return state
  }

  if (!token.startsWith(PUBLISH_TOKEN_PREFIX)) {
    return refuse(skipped("invalid-token"), publishReasonText("invalid-token")!)
  }

  // The payload's "same repo" is conclusive only when its own pull_request IS the
  // PR being published; anything else (issue_comment, push, workflow_run, …) is
  // checked against the resolved PR itself.
  const payloadPr = (context.payload as PrPayload).pull_request?.number
  if (forkFromPayload !== false || payloadPr !== prNumber) {
    let fork: boolean | undefined
    try {
      const { data } = await octokit.rest.pulls.get({ owner: context.repo.owner, repo: context.repo.repo, pull_number: prNumber })
      fork = data.head.repo === null ? true : headDiffersFromBase(data.head.repo?.full_name, data.base.repo?.full_name)
    } catch (err) {
      return refuse(skipped("fork-check-failed"), `could not read PR #${prNumber} to rule out a fork: ${errMessage(err)}`)
    }
    if (fork === undefined) {
      return refuse(skipped("fork-check-failed"), `PR #${prNumber} did not name its head and base repositories`)
    }
    if (fork) {
      core.notice(
        "machinaut-pr-action publish skipped (fork): this pull request comes from a fork; the action never publishes " +
          "a public link for fork pull requests. The comment links the sign-in-walled console.",
      )
      return skipped("fork")
    }
  }

  const res = await publishShare(
    {
      apiUrl: inputs.apiUrl,
      publishToken: token,
      projectId: inputs.projectId,
      sessionId: inputs.sessionId,
      subject: prSubject(context.serverUrl, context.repo.owner, context.repo.repo, prNumber),
    },
    { fetch: deps.fetch },
  )
  if (!res.ok) return refuse(skipped(res.reason, res.status), res.message)

  let url: string
  try {
    url = buildShareUrl(inputs.consoleUrl, res.share.token)
  } catch (err) {
    return refuse(skipped("bad-response"), `could not build the public link: ${errMessage(err)}`)
  }
  core.info(
    `${res.reused ? "reused the live" : "published a"} public post-mortem link (beta): ${url}` +
      `${res.share.expiresAt ? ` — expires ${res.share.expiresAt}` : ""}` +
      `${res.share.replacedShareId ? ` — replaced this PR's previous link (${res.share.replacedShareId})` : ""}`,
  )
  return { kind: "published", reused: res.reused, url, expiresAt: res.share.expiresAt }
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
async function resolvePrNumber(octokit: CommentApi, ctx: GateContext): Promise<number | undefined> {
  const target = prTargetFromPayload(ctx.payload as PrPayload, ctx.sha, ctx.eventName)
  if (typeof target.prNumber === "number") return target.prNumber
  if (!target.sha) return undefined

  // No `.catch` here: a lookup failure must reach run()'s `pr-lookup-failed`
  // handler (and honour fail-on-error), not be flattened into a false "no-pr" skip.
  return findPrNumberForSha(octokit, { owner: ctx.repo.owner, repo: ctx.repo.repo, sha: target.sha })
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
