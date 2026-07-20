import { describe, expect, it } from "vitest"
import { buildTeaser, renderComment, STICKY_MARKER } from "../comment"
import type { SessionReport } from "../machinaut"

const REPORT_MD = [
  "# Lodestar trust report",
  "",
  "**Session**: `sess-demo`",
  "**Project**: `demo`",
  "**Actors**: `planner`, `executor`",
  "**Events**: 13",
  "",
  "## Observations",
  "- `http.get` — schema `page`, trust `unverified`, sensitivity `public` (`0a1b2c3d`)",
].join("\n")

const report: SessionReport = {
  projection: {
    event_count: 13,
    actor_ids: ["planner", "executor"],
    first_event_at: "2026-07-19T00:00:00Z",
    last_event_at: "2026-07-19T00:00:04.2Z",
    actions: [{ terminal_phase: "executed", outcome: { result: "success" } }],
  },
  report_markdown: REPORT_MD,
}

const SESSION_URL = "https://console.machinaut.ai/projects/demo/sessions/sess-demo"

describe("renderComment — invariants are load-bearing in the copy", () => {
  const body = renderComment({ report, sessionUrl: SESSION_URL })

  it("carries the sticky marker for idempotent updates", () => {
    expect(body.startsWith(STICKY_MARKER)).toBe(true)
  })

  it("shows the structured chips (events · agents · verdict · wall)", () => {
    expect(body).toContain("`13 events`")
    expect(body).toContain("`2 agents`")
    expect(body).toContain("**Executed**")
    expect(body).toContain("`4.2s`")
  })

  it("links to the console session and labels it login-walled, not public (candor #4)", () => {
    expect(body).toContain(`(${SESSION_URL})`)
    expect(body.toLowerCase()).toContain("sign-in required")
    expect(body.toLowerCase()).toContain("not** a public post-mortem".toLowerCase())
  })

  it("uses the governance positioning, not 'see your agent's chain'", () => {
    expect(body).toContain("approve, audit, prove")
    expect(body).not.toMatch(/see your agent's chain/i)
  })

  it("attributes the chain/report to Lodestar OSS and names Machinaut's added value (#2)", () => {
    expect(body).toContain("Lodestar")
    expect(body).toContain("open source")
    expect(body).toContain("hosting, tenancy")
  })

  it("quotes the report verbatim inside a fence — never renders it as data (#3)", () => {
    expect(body).toContain("quoted verbatim from the Lodestar report")
    expect(body).toContain("# Lodestar trust report")
    expect(body).toContain("```md")
  })

  it("singularises correctly (1 event / 1 agent)", () => {
    const single = renderComment({
      report: { projection: { event_count: 1, actor_ids: ["solo"], actions: [] }, report_markdown: undefined },
      sessionUrl: SESSION_URL,
    })
    expect(single).toContain("`1 event`")
    expect(single).toContain("`1 agent`")
    expect(single).toContain("**No actions**")
  })

  it("omits the preview block when there is no report markdown", () => {
    const noReport = renderComment({ report: { projection: report.projection }, sessionUrl: SESSION_URL })
    expect(noReport).not.toContain("<details>")
    expect(noReport).not.toContain("```md")
  })
})

describe("buildTeaser — bounded verbatim quote", () => {
  it("returns undefined for empty/absent markdown", () => {
    expect(buildTeaser(undefined)).toBeUndefined()
    expect(buildTeaser("   \n  ")).toBeUndefined()
  })

  it("bounds by line count and reports the elided remainder", () => {
    const md = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")
    const teaser = buildTeaser(md)!
    expect(teaser.elided).toBeGreaterThan(0)
    // The quoted slice is a prefix of the source, never the whole thing.
    expect(teaser.fenced).toContain("line 0")
    expect(teaser.fenced).not.toContain("line 39")
  })

  it("uses a fence longer than any backtick run in the content, so inline code can't break out", () => {
    // Content contains a triple-backtick run; the fence must be ≥4 backticks.
    const md = "here is ``` a fence-looking line"
    const teaser = buildTeaser(md)!
    expect(teaser.fenced.startsWith("````md")).toBe(true)
    expect(teaser.fenced.trimEnd().endsWith("````")).toBe(true)
  })

  it("uses a standard 3-backtick fence for ordinary inline-code content", () => {
    const teaser = buildTeaser("**Events**: `13`")!
    expect(teaser.fenced.startsWith("```md")).toBe(true)
  })
})
