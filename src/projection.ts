/**
 * A minimal, read-only view of the Lodestar wire projection returned by
 * `GET /v1/projects/:p/sessions/:s` — only the fields this action derives its
 * headline chips from. The projection itself is OSS output (`projectChain` /
 * `toWireProjection` in `@qmilab/lodestar-trace`); Machinaut hosts it, we do not
 * produce it (invariant #2).
 *
 * We type just enough to compute events / agents / a status verdict. We never
 * treat the *report markdown* as structured data (invariant #3) — that stays a
 * verbatim quote (see comment.ts). These projection fields, by contrast, ARE the
 * stable structured contract, so reading them is legitimate.
 */
export interface WireProjection {
  session_id?: string
  project_id?: string
  actor_ids?: string[]
  first_event_at?: string
  last_event_at?: string
  event_count?: number
  actions?: ProjectedAction[]
}

export interface ProjectedAction {
  terminal_phase?: string
  outcome?: { result?: string; duration_ms?: number } | null
}

/** Descriptive status label + a plain-text tone hint (no color in markdown). */
export interface DerivedStatus {
  label: string
}

function lc(s?: string): string {
  return (s ?? "").toLowerCase()
}

/**
 * Summarise where the session's governed actions ended up — a faithful port of
 * the console's `deriveSessionStatus` (`explorer/src/lib/sessionSummary.ts`) so
 * the comment's verdict chip reads the SAME as the session page it links to.
 *
 * This is a best-effort read of the OSS action lifecycle (terminal phase +
 * outcome), NOT an approval verdict — we don't see the approval resolution here
 * — so the labels stay descriptive: Executed / Held / Blocked / Failed /
 * Partial / Proposed / No actions.
 */
export function deriveSessionStatus(p: WireProjection): DerivedStatus {
  const actions = p.actions ?? []
  if (actions.length === 0) {
    return { label: "No actions" }
  }

  let held = false
  let blocked = false
  let failed = false
  let partial = false
  let executed = 0
  let withOutcome = 0

  for (const a of actions) {
    const phase = lc(a.terminal_phase)
    const result = lc(a.outcome?.result)
    if (a.outcome) withOutcome++

    if (phase.includes("block") || phase.includes("denied") || phase.includes("reject")) blocked = true
    else if (
      phase.includes("pending") ||
      phase.includes("await") ||
      phase.includes("hold") ||
      phase.includes("approval")
    )
      held = true

    if (result === "failure" || result === "failed") failed = true
    if (result === "partial") partial = true
    else if (result === "success" || phase.includes("execut") || phase.includes("complete")) executed++
  }

  if (blocked) return { label: "Blocked" }
  if (held) return { label: "Held" }
  if (failed) return { label: "Failed" }
  if (partial) return { label: "Partial" }
  if (executed === actions.length) return { label: "Executed" }
  if (withOutcome > 0) return { label: "Partial" }
  return { label: "Proposed" }
}

function toMs(iso?: string): number | undefined {
  if (!iso) return undefined
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : t
}

/** Human wall-clock span between first and last event, e.g. `4.2s` / `1m 03s`.
 *  Ported from the console's `sessionWall` / `fmtDuration`. */
export function sessionWall(p: WireProjection): string | undefined {
  const a = toMs(p.first_event_at)
  const b = toMs(p.last_event_at)
  if (a === undefined || b === undefined) return undefined
  return fmtDuration(Math.max(0, b - a))
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const secs = ms / 1000
  if (secs < 10) return `${secs.toFixed(1)}s`
  const total = Math.round(secs)
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}m ${String(s).padStart(2, "0")}s`
}

/** The headline chips shown at the top of the comment, all derived from the
 *  structured projection (never from the report markdown). */
export interface Chips {
  events: number
  agents: number
  verdict: string
  wall?: string
}

export function deriveChips(p: WireProjection): Chips {
  return {
    events: p.event_count ?? 0,
    agents: p.actor_ids?.length ?? 0,
    verdict: deriveSessionStatus(p).label,
    wall: sessionWall(p),
  }
}
