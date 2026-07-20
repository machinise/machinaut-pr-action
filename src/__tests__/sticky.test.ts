import { describe, expect, it, vi } from "vitest"
import { type CommentApi, type StickyComment, upsertStickyComment } from "../sticky"

const MARKER = "<!-- machinaut-pr-action:v1 -->"

/** A fake octokit whose `paginate(listComments, …)` returns the seeded comments. */
function fakeOctokit(existing: StickyComment[]) {
  const createComment = vi.fn(async ({ body }: { body: string }) => ({
    data: { id: 999, html_url: "https://github.com/o/r/pull/1#issuecomment-999", body } as StickyComment,
  }))
  const updateComment = vi.fn(async ({ comment_id, body }: { comment_id: number; body: string }) => ({
    data: { id: comment_id, html_url: `https://github.com/o/r/pull/1#issuecomment-${comment_id}`, body } as StickyComment,
  }))
  const octokit: CommentApi = {
    paginate: vi.fn(async () => existing) as CommentApi["paginate"],
    rest: {
      issues: { listComments: {}, createComment, updateComment },
      repos: { listPullRequestsAssociatedWithCommit: {} },
    },
  }
  return { octokit, createComment, updateComment }
}

const args = { owner: "o", repo: "r", issueNumber: 1, marker: MARKER, body: `${MARKER}\nhello` }

describe("upsertStickyComment", () => {
  it("creates a comment when none carries the marker", async () => {
    const { octokit, createComment, updateComment } = fakeOctokit([
      { id: 1, html_url: "u", body: "an unrelated comment" },
    ])
    const res = await upsertStickyComment(octokit, args)
    expect(res.action).toBe("created")
    expect(createComment).toHaveBeenCalledOnce()
    expect(updateComment).not.toHaveBeenCalled()
  })

  it("updates the existing marked comment (idempotent re-run)", async () => {
    const { octokit, createComment, updateComment } = fakeOctokit([
      { id: 7, html_url: "u7", body: "unrelated" },
      { id: 42, html_url: "u42", body: `${MARKER}\nprevious evidence` },
    ])
    const res = await upsertStickyComment(octokit, args)
    expect(res.action).toBe("updated")
    expect(res.id).toBe(42)
    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 42, body: args.body }))
    expect(createComment).not.toHaveBeenCalled()
  })

  it("updates the first marked comment when (pathologically) more than one exists", async () => {
    const { octokit, updateComment } = fakeOctokit([
      { id: 10, html_url: "u10", body: `${MARKER} first` },
      { id: 11, html_url: "u11", body: `${MARKER} second` },
    ])
    const res = await upsertStickyComment(octokit, args)
    expect(res.id).toBe(10)
    expect(updateComment).toHaveBeenCalledOnce()
  })
})
