import { type Chips, deriveChips } from "./projection"
import type { SessionReport } from "./machinaut"

/**
 * The hidden marker that makes the comment "sticky": on a re-run we find the
 * prior comment by this string and UPDATE it, so a PR carries exactly one
 * evidence comment however many times CI runs (acceptance criterion, §Increment 1).
 * Versioned so a future copy change can migrate cleanly if ever needed.
 */
export const STICKY_MARKER = "<!-- machinaut-pr-action:v1 -->"

/** Attribution + candor links, kept in one place. */
const LODESTAR_URL = "https://github.com/qmilab/lodestar"
const ACTION_URL = "https://github.com/machinise/machinaut-pr-action"

/** Funnel tag on every Machinaut link the action emits (issue 15). */
export const REF_PARAM = "ref=pr-comment"
/** Public product page; `?ref=` sits before the `#` so the anchor still resolves. */
export const MACHINAUT_INTRO_URL = `https://machinaut.ai/?${REF_PARAM}#agent-prs`

/** Add `?ref=pr-comment` to a URL (before any fragment), keeping existing query. */
export function withRef(url: string): string {
  const hash = url.indexOf("#")
  const base = hash === -1 ? url : url.slice(0, hash)
  const frag = hash === -1 ? "" : url.slice(hash)
  if (/[?&]ref=pr-comment(&|$)/.test(base)) return url
  return `${base}${base.includes("?") ? "&" : "?"}${REF_PARAM}${frag}`
}

/** How much of the OSS report markdown we quote as a teaser. */
const TEASER_MAX_LINES = 16
const TEASER_MAX_CHARS = 1400

export interface RenderInput {
  report: SessionReport
  /** Console deep link to the session (login-walled). */
  sessionUrl: string
}

/**
 * Render the full sticky-comment body.
 *
 * Every invariant from the plan is load-bearing in this copy:
 *  - Candor (#4): the console link is named as sign-in-walled and explicitly
 *    "not a public post-mortem" — an Increment-1 honesty this doc demands.
 *  - Never claim OSS as ours (#2): the chain/report/projection are attributed to
 *    Lodestar; Machinaut's value is named as hosting + tenancy + governance.
 *  - Never parse the report (#3): the preview is a VERBATIM quote in a code
 *    fence, produced by slicing lines — never by extracting fields from it.
 *  - Positioning: "your team governs your agent fleet: approve, audit, prove."
 */
export function renderComment({ report, sessionUrl }: RenderInput): string {
  const chips = deriveChips(report.projection)
  const parts: string[] = []

  parts.push(STICKY_MARKER)
  parts.push("### 🤖 This PR was authored by an agent — here's its evidence trail")
  parts.push("")
  parts.push(renderChips(chips))
  parts.push("")
  parts.push(
    "Your team governs your agent fleet: **approve, audit, prove**. Open the session in " +
      "Machinaut to review exactly what the agent observed, believed, decided, and did — every " +
      "step linked back to the append-only event log.",
  )
  parts.push("")
  parts.push(
    `**[Open this session in Machinaut →](${withRef(sessionUrl)})**  ` +
      "🔒 _Sign-in required — visible to team members already in your Machinaut org. " +
      "This is the internal console, **not** a public post-mortem link._",
  )

  const teaser = buildTeaser(report.report_markdown)
  if (teaser) {
    parts.push("")
    parts.push("<details>")
    parts.push("<summary>Report preview — quoted verbatim from the Lodestar report</summary>")
    parts.push("")
    parts.push(teaser.fenced)
    const note = teaserNote(teaser)
    if (note) {
      parts.push("")
      parts.push(note)
    }
    parts.push("</details>")
  }

  parts.push("")
  parts.push("---")
  parts.push(renderFooter())

  return parts.join("\n")
}

function renderChips(chips: Chips): string {
  const bits = [
    `\`${chips.events} event${chips.events === 1 ? "" : "s"}\``,
    `\`${chips.agents} agent${chips.agents === 1 ? "" : "s"}\``,
    `**${chips.verdict}**`,
  ]
  if (chips.wall) bits.push(`\`${chips.wall}\``)
  return bits.join(" · ")
}

function renderFooter(): string {
  return (
    `<sub>The chain, report, and projection are produced by ` +
    `<a href="${LODESTAR_URL}">Lodestar</a> (open source, Apache-2.0) from the agent's ` +
    `append-only event log — Machinaut adds hosting, tenancy, and the governance surface. ` +
    `Posted by <a href="${ACTION_URL}">machinaut-pr-action</a>; updates in place on re-runs.<br>` +
    `What is Machinaut? <a href="${MACHINAUT_INTRO_URL}">machinaut.ai</a></sub>`
  )
}

export interface Teaser {
  /** The quoted lines wrapped in a fence long enough not to be broken by their content. */
  fenced: string
  /** How many report lines were omitted below the quoted slice. */
  elided: number
  /** True when the quote itself was hard-cut mid-content to honour the char cap. */
  truncated: boolean
}

/**
 * Quote the top of the OSS report markdown, bounded by line and char count.
 *
 * This is a pure string slice — we do NOT interpret the markdown as data
 * (invariant #3). The slice is wrapped in a code fence sized one backtick longer
 * than the longest backtick run inside it, so report content (which uses inline
 * `code`) can never terminate the fence early. Returns undefined when there's no
 * report markdown (report=1 omitted, or an empty session).
 */
export function buildTeaser(markdown: string | undefined): Teaser | undefined {
  if (!markdown || !markdown.trim()) return undefined

  const allLines = markdown.replace(/\r\n/g, "\n").split("\n")
  let sliced = allLines.slice(0, TEASER_MAX_LINES)

  // Char cap: drop trailing lines until under the budget (keep at least one line).
  while (sliced.length > 1 && sliced.join("\n").length > TEASER_MAX_CHARS) {
    sliced = sliced.slice(0, -1)
  }

  // Trim trailing blank lines from the quoted slice (cosmetic, not data).
  while (sliced.length > 1 && sliced[sliced.length - 1]!.trim() === "") {
    sliced = sliced.slice(0, -1)
  }

  let quoted = sliced.join("\n")
  const elided = Math.max(0, allLines.length - sliced.length)

  // Line-dropping keeps at least one line, so a single line longer than the cap
  // (e.g. a huge tool-output line in the report) would still blow the budget and
  // could make the comment oversized enough for the GitHub API to reject. Hard-cut
  // the raw text — still a verbatim prefix quote — and flag it so the note fires.
  let truncated = false
  if (quoted.length > TEASER_MAX_CHARS) {
    quoted = quoted.slice(0, TEASER_MAX_CHARS).replace(/\s+\S*$/, "") // avoid a mid-word cut
    truncated = true
  }

  const fence = "`".repeat(longestBacktickRun(quoted) + 1)
  const fenced = `${fence}md\n${quoted}\n${fence}`
  return { fenced, elided, truncated }
}

/** The italic "there's more" line under the preview, or "" when the quote is the
 *  whole report. Covers both whole-line elision and a mid-content hard-cut. */
export function teaserNote(teaser: Teaser): string {
  if (teaser.elided > 0) {
    return `_…${teaser.elided} more line(s) in the full report — open the session above._`
  }
  if (teaser.truncated) {
    return "_…preview truncated — open the session above for the full report._"
  }
  return ""
}

/** Longest consecutive run of backticks in `s` (min 2, so the fence is always ≥3). */
function longestBacktickRun(s: string): number {
  let longest = 0
  let run = 0
  for (const ch of s) {
    if (ch === "`") {
      run++
      if (run > longest) longest = run
    } else {
      run = 0
    }
  }
  return Math.max(2, longest)
}
