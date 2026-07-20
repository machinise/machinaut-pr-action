import { describe, expect, it, vi } from "vitest"
import { type CommentApi, type StickyComment, upsertStickyComment } from "../sticky"

const MARKER = "<!-- machinaut-pr-action:v1 -->"

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status })

/**
 * A fake octokit whose `paginate(listComments, …)` returns the seeded comments.
 * `opts.updateError(id)` lets a test make `updateComment` throw for specific
 * comment ids (e.g. a 403 for a comment the token can't edit).
 */
function fakeOctokit(existing: StickyComment[], opts: { updateError?: (id: number) => Error | undefined } = {}) {
  const createComment = vi.fn(async ({ body }: { body: string }) => ({
    data: { id: 999, html_url: "https://github.com/o/r/pull/1#issuecomment-999", body } as StickyComment,
  }))
  const updateComment = vi.fn(async ({ comment_id, body }: { comment_id: number; body: string }) => {
    const err = opts.updateError?.(comment_id)
    if (err) throw err
    return {
      data: {
        id: comment_id,
        html_url: `https://github.com/o/r/pull/1#issuecomment-${comment_id}`,
        body,
      } as StickyComment,
    }
  })
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

  it("skips a marker comment it can't edit (403) and updates the next editable one", async () => {
    // A stray/adversarial marker comment (id 10) that our token can't edit, then
    // our own (id 11). Must skip the 403 and update ours — stays idempotent.
    const { octokit, createComment, updateComment } = fakeOctokit(
      [
        { id: 10, html_url: "u10", body: `${MARKER} planted by someone else` },
        { id: 11, html_url: "u11", body: `${MARKER} ours` },
      ],
      { updateError: (id) => (id === 10 ? httpError(403) : undefined) },
    )
    const res = await upsertStickyComment(octokit, args)
    expect(res.action).toBe("updated")
    expect(res.id).toBe(11)
    expect(updateComment).toHaveBeenCalledTimes(2)
    expect(createComment).not.toHaveBeenCalled()
  })

  it("creates a fresh comment when the only marker comment isn't editable (403)", async () => {
    const { octokit, createComment } = fakeOctokit(
      [{ id: 10, html_url: "u10", body: `${MARKER} planted by someone else` }],
      { updateError: () => httpError(403) },
    )
    const res = await upsertStickyComment(octokit, args)
    expect(res.action).toBe("created")
    expect(res.id).toBe(999)
    expect(createComment).toHaveBeenCalledOnce()
  })

  it("treats a 404 (comment deleted between list and update) as not-ours and creates", async () => {
    const { octokit, createComment } = fakeOctokit([{ id: 10, html_url: "u10", body: `${MARKER} was here` }], {
      updateError: () => httpError(404),
    })
    const res = await upsertStickyComment(octokit, args)
    expect(res.action).toBe("created")
    expect(createComment).toHaveBeenCalledOnce()
  })

  it("re-throws a real update error (e.g. rate limit) instead of masking it as a create", async () => {
    const { octokit, createComment } = fakeOctokit([{ id: 42, html_url: "u42", body: `${MARKER} ours` }], {
      updateError: () => httpError(429),
    })
    await expect(upsertStickyComment(octokit, args)).rejects.toMatchObject({ status: 429 })
    expect(createComment).not.toHaveBeenCalled()
  })
})
