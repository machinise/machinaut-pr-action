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

  const prior = existing.find((c) => typeof c.body === "string" && c.body.includes(marker))

  if (prior) {
    const { data } = await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: prior.id,
      body,
    })
    return { id: data.id, html_url: data.html_url, action: "updated" }
  }

  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  })
  return { id: data.id, html_url: data.html_url, action: "created" }
}
