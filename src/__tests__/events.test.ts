import { describe, expect, it } from "vitest"
import {
  findPrNumberForSha,
  forkHeadFromPayload,
  headDiffersFromBase,
  headShaFromPayload,
  type PrLister,
  prTargetFromPayload,
} from "../events"

const CONTEXT_SHA = "default-branch-sha"

describe("prTargetFromPayload", () => {
  it("uses the pull_request number directly (pull_request / _target)", () => {
    expect(
      prTargetFromPayload({ pull_request: { number: 7, head: { sha: "head7" } } }, CONTEXT_SHA, "pull_request"),
    ).toEqual({ prNumber: 7 })
  })

  it("uses the issue number for an issue_comment on a PR", () => {
    expect(
      prTargetFromPayload({ issue: { number: 9, pull_request: { url: "…" } } }, CONTEXT_SHA, "issue_comment"),
    ).toEqual({ prNumber: 9 })
  })

  it("does NOT fall back to context.sha for an issue_comment on a plain issue (the P2 fix)", () => {
    // context.sha here is the default-branch commit — resolving a PR from it could
    // post to an unrelated PR. A plain-issue comment must produce no target.
    expect(prTargetFromPayload({ issue: { number: 9 } }, CONTEXT_SHA, "issue_comment")).toEqual({})
  })

  it("does NOT fall back to context.sha for workflow_dispatch / schedule", () => {
    expect(prTargetFromPayload({}, CONTEXT_SHA, "workflow_dispatch")).toEqual({})
    expect(prTargetFromPayload({}, CONTEXT_SHA, "schedule")).toEqual({})
  })

  it("workflow_run: prefers the run's own PR list over any SHA", () => {
    expect(
      prTargetFromPayload(
        { workflow_run: { head_sha: "head-abc", pull_requests: [{ number: 42 }] } },
        CONTEXT_SHA,
        "workflow_run",
      ),
    ).toEqual({ prNumber: 42 })
  })

  it("workflow_run without a PR list falls back to the run head_sha, NOT context.sha", () => {
    const t = prTargetFromPayload(
      { workflow_run: { head_sha: "pr-head-sha", pull_requests: [] } },
      CONTEXT_SHA,
      "workflow_run",
    )
    expect(t.prNumber).toBeUndefined()
    expect(t.sha).toBe("pr-head-sha")
    expect(t.sha).not.toBe(CONTEXT_SHA)
  })

  it("uses context.sha on push and merge_group (where it IS the head commit)", () => {
    expect(prTargetFromPayload({}, CONTEXT_SHA, "push")).toEqual({ sha: CONTEXT_SHA })
    expect(prTargetFromPayload({}, CONTEXT_SHA, "merge_group")).toEqual({ sha: CONTEXT_SHA })
  })

  it("returns an empty target when there is no PR and no usable SHA", () => {
    expect(prTargetFromPayload({}, undefined, "push")).toEqual({})
    expect(prTargetFromPayload({}, CONTEXT_SHA, undefined)).toEqual({})
  })
})

describe("findPrNumberForSha", () => {
  const lister = (resolve: () => Promise<unknown[]>): PrLister => ({
    paginate: (async () => resolve()) as PrLister["paginate"],
    rest: { repos: { listPullRequestsAssociatedWithCommit: {} } },
  })

  it("returns the open PR's number, preferring it over closed ones", async () => {
    const octokit = lister(async () => [
      { number: 3, state: "closed" },
      { number: 5, state: "open" },
    ])
    expect(await findPrNumberForSha(octokit, { owner: "o", repo: "r", sha: "s" })).toBe(5)
  })

  it("falls back to the first PR when none is open", async () => {
    const octokit = lister(async () => [{ number: 8, state: "closed" }])
    expect(await findPrNumberForSha(octokit, { owner: "o", repo: "r", sha: "s" })).toBe(8)
  })

  it("returns undefined for a commit on no PR (empty list is NOT an error)", async () => {
    const octokit = lister(async () => [])
    expect(await findPrNumberForSha(octokit, { owner: "o", repo: "r", sha: "s" })).toBeUndefined()
  })

  it("propagates API errors instead of swallowing them into a false no-PR (the P2 fix)", async () => {
    const octokit = lister(async () => {
      throw new Error("Bad credentials")
    })
    await expect(findPrNumberForSha(octokit, { owner: "o", repo: "r", sha: "s" })).rejects.toThrow("Bad credentials")
  })
})

describe("headShaFromPayload (gate mode's gitCommit subject)", () => {
  it("prefers pull_request.head.sha over the merge commit in context.sha", () => {
    expect(headShaFromPayload({ pull_request: { number: 1, head: { sha: "head1" } } }, CONTEXT_SHA, "pull_request")).toBe("head1")
  })
  it("uses workflow_run.head_sha", () => {
    expect(headShaFromPayload({ workflow_run: { head_sha: "run-head" } }, CONTEXT_SHA, "workflow_run")).toBe("run-head")
  })
  it("uses context.sha only on push / merge_group", () => {
    expect(headShaFromPayload({}, "tip", "push")).toBe("tip")
    expect(headShaFromPayload({}, CONTEXT_SHA, "issue_comment")).toBeUndefined()
    expect(headShaFromPayload({}, CONTEXT_SHA, "workflow_dispatch")).toBeUndefined()
  })
})

describe("forkHeadFromPayload (publishing: never for a fork's PR)", () => {
  const base = { repo: { full_name: "acme/widgets" } }

  it("same-repo pull_request → false", () => {
    expect(forkHeadFromPayload({ pull_request: { head: { repo: { full_name: "Acme/Widgets" } }, base } })).toBe(false)
  })

  it("fork pull_request (and pull_request_target, whose payload is the same) → true", () => {
    expect(forkHeadFromPayload({ pull_request: { head: { repo: { full_name: "mallory/widgets" } }, base } })).toBe(true)
  })

  it("a deleted fork (head.repo null) → true", () => {
    expect(forkHeadFromPayload({ pull_request: { head: { repo: null }, base } })).toBe(true)
  })

  it("workflow_run compares head_repository with repository", () => {
    const repository = { full_name: "acme/widgets" }
    expect(forkHeadFromPayload({ workflow_run: { head_repository: { full_name: "mallory/widgets" }, repository } })).toBe(true)
    expect(forkHeadFromPayload({ workflow_run: { head_repository: { full_name: "acme/widgets" }, repository } })).toBe(false)
    expect(forkHeadFromPayload({ workflow_run: { head_repository: null, repository } })).toBe(true)
  })

  it("cannot say for payloads without repos (issue_comment, push, or a stripped PR payload)", () => {
    expect(forkHeadFromPayload({})).toBeUndefined()
    expect(forkHeadFromPayload({ pull_request: { head: {}, base: {} } })).toBeUndefined()
    expect(forkHeadFromPayload({ workflow_run: {} })).toBeUndefined()
  })

  it("headDiffersFromBase is case-insensitive and undefined when a name is missing", () => {
    expect(headDiffersFromBase("A/B", "a/b")).toBe(false)
    expect(headDiffersFromBase("x/b", "a/b")).toBe(true)
    expect(headDiffersFromBase(undefined, "a/b")).toBeUndefined()
  })
})
