import { describe, expect, it } from "vitest"
import { prTargetFromPayload } from "../events"

const CONTEXT_SHA = "default-branch-sha"

describe("prTargetFromPayload", () => {
  it("uses the pull_request number directly (pull_request / _target)", () => {
    expect(prTargetFromPayload({ pull_request: { number: 7, head: { sha: "head7" } } }, CONTEXT_SHA)).toEqual({
      prNumber: 7,
    })
  })

  it("uses the issue number for an issue_comment on a PR", () => {
    expect(prTargetFromPayload({ issue: { number: 9, pull_request: { url: "…" } } }, CONTEXT_SHA)).toEqual({
      prNumber: 9,
    })
  })

  it("ignores an issue_comment that is NOT on a PR", () => {
    const t = prTargetFromPayload({ issue: { number: 9 } }, CONTEXT_SHA)
    expect(t.prNumber).toBeUndefined()
    expect(t.sha).toBe(CONTEXT_SHA)
  })

  it("workflow_run: prefers the run's own PR list over any SHA", () => {
    expect(
      prTargetFromPayload(
        { workflow_run: { head_sha: "head-abc", pull_requests: [{ number: 42 }] } },
        CONTEXT_SHA,
      ),
    ).toEqual({ prNumber: 42 })
  })

  it("workflow_run without a PR list falls back to the run head_sha, NOT context.sha (the P2 fix)", () => {
    // The whole point: on workflow_run, context.sha is the default-branch SHA, so
    // using it would look up the wrong PR / none. We must use the run's head_sha.
    const t = prTargetFromPayload({ workflow_run: { head_sha: "pr-head-sha", pull_requests: [] } }, CONTEXT_SHA)
    expect(t.prNumber).toBeUndefined()
    expect(t.sha).toBe("pr-head-sha")
    expect(t.sha).not.toBe(CONTEXT_SHA)
  })

  it("push / merge_group: looks up by the context SHA", () => {
    expect(prTargetFromPayload({}, CONTEXT_SHA)).toEqual({ sha: CONTEXT_SHA })
  })

  it("returns an empty target when there is no PR and no SHA at all", () => {
    expect(prTargetFromPayload({}, undefined)).toEqual({})
  })
})
