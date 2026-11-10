import { describe, expect, it } from "vitest"
import { buildTeaser, renderComment, withRef, STICKY_MARKER, type Teaser, teaserNote } from "../comment"
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
    expect(body).toContain(`(${SESSION_URL}?ref=pr-comment)`)
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

  it("hard-caps a SINGLE line longer than the char budget (the P2 fix)", () => {
    // A report that is one giant line: line-dropping can't help (it keeps ≥1 line),
    // so the quote itself must be cut. Previously this left the teaser unbounded.
    const giant = `# ${"x".repeat(5000)}`
    const teaser = buildTeaser(giant)!
    expect(teaser.truncated).toBe(true)
    // Bounded well under the source; fence + "md\n" adds only a few chars.
    expect(teaser.fenced.length).toBeLessThan(1500)
    expect(teaser.fenced).not.toContain("x".repeat(2000))
  })

  it("does not truncate a report already under the char budget", () => {
    const teaser = buildTeaser("# Lodestar trust report\n\n**Events**: 5")!
    expect(teaser.truncated).toBe(false)
  })
})

describe("teaserNote", () => {
  const base: Teaser = { fenced: "```md\nx\n```", elided: 0, truncated: false }

  it("reports elided whole lines", () => {
    expect(teaserNote({ ...base, elided: 3 })).toContain("3 more line(s)")
  })

  it("reports a mid-content truncation when no whole lines were elided", () => {
    expect(teaserNote({ ...base, elided: 0, truncated: true })).toContain("preview truncated")
  })

  it("is empty when the quote IS the whole report", () => {
    expect(teaserNote(base)).toBe("")
  })
})

describe("renderComment with an oversized single-line report", () => {
  it("stays bounded and discloses the truncation", () => {
    const giant = `# ${"y".repeat(8000)}`
    const body = renderComment({
      report: { projection: { event_count: 1, actor_ids: [], actions: [] }, report_markdown: giant },
      sessionUrl: SESSION_URL,
    })
    expect(body).toContain("preview truncated")
    expect(body.length).toBeLessThan(3000) // nowhere near the 8000-char line
  })
})

describe("funnel links (issue 15)", () => {
  it("tags the session link and adds the footer intro link, ref before the anchor", () => {
    const body = renderComment({ report, sessionUrl: SESSION_URL })
    expect(body).toContain(`](${SESSION_URL}?ref=pr-comment)`)
    expect(body).toContain('What is Machinaut? <a href="https://machinaut.ai/?ref=pr-comment#agent-prs">machinaut.ai</a>')
  })
  it("withRef keeps queries and fragments, and is idempotent", () => {
    expect(withRef("https://x.test/a?b=1#f")).toBe("https://x.test/a?b=1&ref=pr-comment#f")
    expect(withRef(withRef("https://x.test/a"))).toBe("https://x.test/a?ref=pr-comment")
  })
})

describe("renderComment — public post-mortem link (planned, ADR-0002)", () => {
  const SHARE_URL = "https://console.machinaut.ai/s/sh_AbCdEfGhIjKlMnOpQrStUvWxYz012345"
  const plain = renderComment({ report, sessionUrl: SESSION_URL })

  it("no publish state, or a skip without a configured token, renders the comment unchanged", () => {
    expect(renderComment({ report, sessionUrl: SESSION_URL, publish: undefined })).toBe(plain)
    expect(
      renderComment({ report, sessionUrl: SESSION_URL, publish: { kind: "skipped", reason: "no-token", configured: false } }),
    ).toBe(plain)
    expect(
      renderComment({ report, sessionUrl: SESSION_URL, publish: { kind: "skipped", reason: "fork", configured: false } }),
    ).toBe(plain)
  })

  it("published: leads with the public link, labelled Beta, public, expiring; keeps the console link", () => {
    const body = renderComment({
      report,
      sessionUrl: SESSION_URL,
      publish: { kind: "published", reused: false, url: SHARE_URL, expiresAt: "2026-12-10T10:47:00Z" },
    })
    const publicAt = body.indexOf(`[Open the public post-mortem →](${SHARE_URL}?ref=pr-comment)`)
    const consoleAt = body.indexOf(`(${SESSION_URL}?ref=pr-comment)`)
    expect(publicAt).toBeGreaterThan(-1)
    expect(consoleAt).toBeGreaterThan(publicAt)
    expect(body).toContain("Public post-mortem link (Beta). Anyone with the link can view it. Expires 2026-12-10 (UTC).")
    expect(body).toContain("sign-in required")
    expect(body).not.toContain("not** a public post-mortem")
    expect(body.startsWith(STICKY_MARKER)).toBe(true)
  })

  it("published without an expiry says so rather than inventing one", () => {
    const body = renderComment({ report, sessionUrl: SESSION_URL, publish: { kind: "published", reused: true, url: SHARE_URL } })
    expect(body).toContain("Machinaut did not report an expiry.")
  })

  it("configured but not published: the console link as before plus one reason line", () => {
    const body = renderComment({
      report,
      sessionUrl: SESSION_URL,
      publish: { kind: "skipped", reason: "ceiling-above-token", configured: true, status: 409 },
    })
    expect(body).toContain("not** a public post-mortem link")
    const reasonLines = body.split("\n").filter((l) => l.startsWith("Public link not published: "))
    expect(reasonLines).toHaveLength(1)
    expect(reasonLines[0]).toContain("`--sensitivity-ceiling public`")
  })
})
