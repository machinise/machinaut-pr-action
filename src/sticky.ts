/**
 * Find-or-update the single evidence comment on a PR, keyed by a hidden marker.
 *
 * Idempotency is an Increment-1 acceptance criterion: however many times CI
 * re-runs on a PR, there must be exactly one evidence comment. We list the
 * issue's comments, find the first whose body carries {@link STICKY_MARKER}, and
 * UPDATE it; only when none exists do we CREATE one.
 */

/** The narrow slice of Octokit this module needs — kept minimal so it's trivial
 *  to fake in tests and doesn't couple to the full `@actions/github` types. */
export interface CommentApi {
  paginate: <T>(
    route: unknown,
    params: Record<string, unknown>,
  ) => Promise<T[]>
  rest: {
    issues: {
      listComments: unknown
      createComment: (params: {
        owner: string
        repo: string
        issue_number: number
        body: string
      }) => Promise<{ data: StickyComment }>
      updateComment: (params: {
        owner: string
        repo: string
        comment_id: number
        body: string
      }) => Promise<{ data: StickyComment }>
    }
    repos: {
      /** Route object handed to `paginate` to find the PR(s) a commit belongs to. */
      listPullRequestsAssociatedWithCommit: unknown
    }
  }
}

export interface StickyComment {
  id: number
  html_url: string
  body?: string | null
}

export interface UpsertResult {
  id: number
  html_url: string
  action: "created" | "updated"
}

export async function upsertStickyComment(
  octokit: CommentApi,
  args: {
    owner: string
    repo: string
    issueNumber: number
    marker: string
    body: string
  },
): Promise<UpsertResult> {
  const { owner, repo, issueNumber, marker, body } = args

  const existing = await octokit.paginate<StickyComment>(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  })

  // A marker comment planted by a DIFFERENT identity (a stray or adversarial one)
  // can't be edited by our token — GitHub answers 403 — and a comment deleted
  // between the list and the update answers 404. Either way it isn't ours to
  // reuse: skip it and try the next marker comment; if none are editable, create
  // our own. This keeps exactly one evidence comment even when someone else
  // planted the marker, and never lets their comment block ours. Any OTHER error
  // (rate limit, outage, oversized body) is a real failure and is re-thrown so it
  // reaches run()'s comment-failed handler instead of being masked.
  const markerComments = existing.filter((c) => typeof c.body === "string" && c.body.includes(marker))

  for (const prior of markerComments) {
    try {
      const { data } = await octokit.rest.issues.updateComment({ owner, repo, comment_id: prior.id, body })
      return { id: data.id, html_url: data.html_url, action: "updated" }
    } catch (err) {
      if (!isNotEditable(err)) throw err
      // not ours / already gone — fall through to the next candidate, then create
    }
  }

  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  })
  return { id: data.id, html_url: data.html_url, action: "created" }
}

/** Whether a failed comment update means "this comment isn't ours to edit" (403)
 *  or "it's gone" (404) — a signal to move on / create — versus a real error
 *  (rate limit, 5xx, 422 oversized body) that must surface. */
function isNotEditable(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status
  return status === 403 || status === 404
}
