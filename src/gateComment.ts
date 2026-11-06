import type { GateResult, PredicatePolicy } from "./gate"
import type { GovernanceSummary, HoldEvidence, HoldOutcome } from "./governance"
import type { IntakeState } from "./intake"
import type { SignerIdentity } from "./signerIdentity"
import { PREDICATE_TYPE, SUMMARY_SUBJECT_NAME } from "./statement"
import { type SkipReason, STORE_HINT } from "./signing"

/**
 * The gate's sticky comment. A separate marker from comment mode's, so a repo
 * that runs both modes keeps one evidence comment AND one verdict comment rather
 * than having them overwrite each other.
 */
export const GATE_STICKY_MARKER = "<!-- machinaut-pr-action:gate:v1 -->"

/** The check name the README tells teams to require (workflow `machinaut`, job `governed-run`). */
export const CHECK_NAME = "machinaut / governed-run"

const LODESTAR_URL = "https://github.com/qmilab/lodestar"
const ACTION_URL = "https://github.com/machinise/machinaut-pr-action"
const GATE_DOCS_URL = `${ACTION_URL}#gate-mode-beta`

export type AttestationState =
  | { kind: "signed"; attestationUrl?: string; tlogId?: string; storeError?: string }
  | { kind: "skipped"; reason: SkipReason; detail: string }
  | { kind: "failed"; message: string }

export interface GateCommentInput {
  summary: GovernanceSummary
  result: GateResult
  policy: PredicatePolicy
  dryRun: boolean
  headSha: string
  sessionUrl: string
  attestation: AttestationState
  /** Defaults to not attempted (unsigned). */
  intake?: IntakeState
  /**
   * For the verify recipe: `owner/repo`, plus who signed. `signer` is read off the
   * bundle's signing certificate and wins; `signerWorkflow`
   * (`owner/repo/.github/workflows/x.yml`, from GITHUB_WORKFLOW_REF) is the fallback
   * for a bundle with no readable certificate — and is labelled as such, since for a
   * reusable workflow it names the caller, not the workflow that signed.
   */
  verify?: { repo: string; signer?: SignerIdentity; signerWorkflow?: string }
}

/** Shown when the recipe's `--signer-workflow` could not be read from a certificate. */
export const WORKFLOW_REF_FALLBACK_NOTE = "(derived from the workflow ref; may differ for reusable workflows)"

/**
 * Candor (plan §2.5), condensed for the check output. Load-bearing: what the gate
 * proves and does not prove; `relay_only` ≠ verified; the verification itself is
 * Lodestar OSS; GitHub — not Machinaut — enforces the check.
 */
export const CANDOR_LINES = [
  "> **What this proves:** this repo's CI evaluated the facts Machinaut held for the session at `as_of` and, " +
    "when signed, signed that decision with its own identity. It does **not** prove the agent could not have " +
    "misbehaved, or that the event log is complete. A `relay_only` hold is **not** a verified approval; " +
    "redacted records are attested by commitment, not content.",
  "> Hash verification, approval-signature verification, quorum adjudication, redaction and sentinel detection " +
    `are [Lodestar](${LODESTAR_URL}) OSS. GitHub enforces this check through your branch protection — ` +
    "Machinaut cannot block a merge.",
]

/** The artifact the example workflow uploads the evidence files as. */
export const EVIDENCE_ARTIFACT = "machinaut-governed-run"

/** One line; the same text the console shows as `verify_recipe`. */
export function verifyRecipe(
  repo: string,
  signerWorkflow = "<owner>/<repo>/.github/workflows/<workflow>.yml",
  bundle = false,
): string {
  const quoted = /^[A-Za-z0-9_.\/<>-]+$/.test(signerWorkflow) ? signerWorkflow : `'${signerWorkflow.replace(/'/g, `'\\''`)}'`
  return (
    `gh attestation verify ${SUMMARY_SUBJECT_NAME} --repo ${repo} --predicate-type ${PREDICATE_TYPE} ` +
    `--signer-workflow ${quoted}${bundle ? " --bundle governed-run.sigstore.json" : ""}`
  )
}

export function renderGateComment(input: GateCommentInput): string {
  const { summary, result, dryRun } = input
  const parts: string[] = [GATE_STICKY_MARKER, headline(result, dryRun), ""]

  parts.push(
    `Commit ${code(input.headSha.slice(0, 12))} · session ${code(summary.machinaut.session_id)} · ` +
      `facts as held by Machinaut at ${code(summary.machinaut.as_of)}`,
  )

  if (result.failures.length > 0) {
    parts.push("")
    parts.push(dryRun ? "**Would fail because:**" : "**Why it failed:**")
    for (const r of result.failures) parts.push(`- ${escapeMd(r)}`)
  }
  if (result.notes.length > 0) {
    parts.push("")
    parts.push("**Not evaluated (allowed by policy):**")
    for (const n of result.notes) parts.push(`- ${escapeMd(n)}`)
  }

  parts.push("")
  parts.push("| | |")
  parts.push("| --- | --- |")
  parts.push(`| **Chain** | ${chainCell(summary)} |`)
  parts.push(`| **Holds** | ${holdsCell(summary)} |`)
  parts.push(
    `| **Sentinels** | ${summary.sentinels.critical} critical · ${summary.sentinels.warning} warning · ` +
      `${summary.sentinels.info} info |`,
  )
  parts.push(
    `| **Unreadable** | ${summary.unreadable.approval_requests} approval request(s) · ` +
      `${summary.unreadable.sentinel_alerts} sentinel alert(s) withheld by the shipper (below the secret ceiling) |`,
  )
  parts.push(`| **Policy** | ${policyCell(input.policy)} |`)

  parts.push("")
  parts.push(`**Attestation:** ${attestationLine(input.attestation)}`)
  if (input.attestation.kind === "signed" && input.verify) {
    const { signer } = input.verify
    if (signer) {
      parts.push("")
      parts.push(signerLine(signer))
    }
    parts.push("")
    parts.push(
      `**Verify without Machinaut** — download the \`${SUMMARY_SUBJECT_NAME}\` file from this run's ` +
        `\`${EVIDENCE_ARTIFACT}\` artifact${input.attestation.storeError ? " (plus `governed-run.sigstore.json`, since GitHub did not store it)" : ""}, then:`,
    )
    parts.push("```bash")
    parts.push(
      verifyRecipe(input.verify.repo, signer?.signerWorkflow ?? input.verify.signerWorkflow, Boolean(input.attestation.storeError)),
    )
    parts.push("```")
    if (!signer && input.verify.signerWorkflow) {
      parts.push(
        `\`--signer-workflow\` ${WORKFLOW_REF_FALLBACK_NOTE}: the bundle carried no signing certificate to read it from.`,
      )
    }
  }
  parts.push("")
  parts.push(`**Recorded in Machinaut:** ${intakeLine(input.intake ?? { kind: "not_attempted", why: "unsigned" })}`)
  parts.push("")
  parts.push(
    `**[Open the evidence in Machinaut →](${input.sessionUrl})**  ` +
      "🔒 _Sign-in required — your team's console, not a public page._",
  )
  parts.push("")
  parts.push(...CANDOR_LINES)
  parts.push("")
  parts.push("---")
  parts.push(footer())
  return parts.join("\n")
}

/** Posted when the gate could not evaluate at all (API down, unsupported summary
 *  version, …): no decision was made and nothing was signed — said plainly. */
export function renderGateErrorComment(input: { sessionUrl?: string; message: string; dryRun: boolean }): string {
  const parts: string[] = [
    GATE_STICKY_MARKER,
    `### ⚠️ ${CHECK_NAME}${input.dryRun ? " (dry run)" : ""}: could not evaluate <sup>beta</sup>`,
    "",
    `The gate could not read the governance facts for this run, so **no decision was made and nothing was signed**: ` +
      escapeMd(input.message),
  ]
  if (input.sessionUrl) {
    parts.push("")
    parts.push(`[Open the session in Machinaut →](${input.sessionUrl})  🔒 _Sign-in required._`)
  }
  parts.push("")
  parts.push("---")
  parts.push(footer())
  return parts.join("\n")
}

function headline(result: GateResult, dryRun: boolean): string {
  if (dryRun) {
    return (
      `### 🧪 ${CHECK_NAME} (dry run): would **${result.decision}** — not enforced <sup>beta</sup>`
    )
  }
  return result.decision === "pass"
    ? `### ✅ ${CHECK_NAME}: **pass** <sup>beta</sup>`
    : `### ❌ ${CHECK_NAME}: **fail** <sup>beta</sup>`
}

function chainCell(s: GovernanceSummary): string {
  const c = s.chain
  const seqs = c.first_seq !== null && c.last_seq !== null ? ` · seq ${c.first_seq}–${c.last_seq}` : ""
  return (
    `${c.events} event${c.events === 1 ? "" : "s"} · ${c.readable} readable · ` +
    `${c.redacted_commitments} redacted (commitment only)${seqs} · digest ${code(abbrevDigest(c.chain_digest))}`
  )
}

const EVIDENCE_LABEL: Record<HoldEvidence, string> = {
  host_record: "host record",
  relay_only: "relay only (unverified)",
  unavailable: "unavailable",
}
const OUTCOME_ORDER: HoldOutcome[] = ["granted", "denied", "expired", "unresolved"]
const EVIDENCE_ORDER: HoldEvidence[] = ["host_record", "relay_only", "unavailable"]

function holdsCell(s: GovernanceSummary): string {
  if (s.holds.length === 0) return s.holds_truncated ? "none shown — **list truncated**" : "none"
  const outcomes = OUTCOME_ORDER.map((o) => [o, s.holds.filter((h) => h.outcome === o).length] as const)
    .filter(([, n]) => n > 0)
    .map(([o, n]) => `${n} ${o}`)
  const evidence = EVIDENCE_ORDER.map((e) => [e, s.holds.filter((h) => h.evidence === e).length] as const)
    .filter(([, n]) => n > 0)
    .map(([e, n]) => `${n} ${EVIDENCE_LABEL[e]}`)
  const bound = s.holds.filter((h) => h.action_representation_hash).length
  const quorum = s.holds.filter((h) => h.quorum).length
  const extras = [bound > 0 ? `${bound} bound (ADR-0042)` : "", quorum > 0 ? `${quorum} host-adjudicated quorum` : ""]
    .filter(Boolean)
    .join(" · ")
  const truncated = s.holds_truncated ? " — **list truncated** (not every hold is shown)" : ""
  return (
    `${s.holds.length}: ${outcomes.join(" · ")} — evidence: ${evidence.join(" · ")}` +
    `${extras ? ` — ${extras}` : ""}${truncated}`
  )
}

function policyCell(p: PredicatePolicy): string {
  return [
    `holds resolved by a host record: ${p.require_holds_resolved ? "required" : "not required"}`,
    `bound approvals: ${p.require_bound_approvals ? "required" : "not required"}`,
    `max sentinel severity: ${p.max_sentinel_severity}`,
    `unreadable records: ${p.allow_unreadable ? "allowed (stated, not evaluated)" : "fail closed"}`,
  ].join(" · ")
}

function attestationLine(a: AttestationState): string {
  switch (a.kind) {
    case "signed": {
      const where = a.attestationUrl ? ` — [view attestation](${a.attestationUrl})` : ""
      const stored = a.storeError
        ? ` ⚠️ Signed, but **not stored** in GitHub (${escapeMd(a.storeError)}) — ${STORE_HINT}. The bundle is ` +
          "saved by this run (`bundle-path` output) for offline `gh attestation verify --bundle`."
        : ""
      return `✍️ signed by this workflow via Sigstore (keyless, this workflow's own OIDC identity)${where}.${stored}`
    }
    case "skipped":
      return `🚫 **unsigned (${a.reason})** — ${a.detail}.`
    case "failed":
      return `❌ **signing failed** — ${escapeMd(a.message)}. No attestation was produced for this run.`
  }
}

/** The certificate SAN — the identity the console's pin is matched against, exactly. */
function signerLine(signer: SignerIdentity): string {
  const prHint = /^refs\/pull\/[0-9]+\/merge$/.test(signer.ref) ? ` (or \`refs/pull/*/merge\` to cover every PR)` : ""
  return (
    `**Signer identity:** ${code(signer.san)} — read from the signing certificate. ` +
    `Your Machinaut console's identity pin (beta) must equal it exactly: workflow ${code(signer.workflowUrl)}, ` +
    `ref ${code(signer.ref)}${prHint}.`
  )
}

/** Reports only that the upload happened. Machinaut verifies on its side and labels the result in the console. */
function intakeLine(i: IntakeState): string {
  switch (i.kind) {
    case "recorded":
      return "yes — uploaded; Machinaut verifies it on its side and shows the result in the console"
    case "not_available":
      return "not available on this console"
    case "rejected":
      return `rejected (${escapeMd(i.reason)})`
    case "failed":
      return i.status === 0 ? "failed (could not reach Machinaut)" : `failed (HTTP ${i.status})`
    case "not_attempted":
      return `not attempted (${i.why === "post-attestation-false" ? "post-attestation: false" : i.why})`
  }
}

function footer(): string {
  return (
    `<sub>Gate mode is **beta**. Facts served by Machinaut; the decision and the signature are made by this ` +
    `workflow, never by Machinaut. [How to verify](${GATE_DOCS_URL}) · posted by ` +
    `<a href="${ACTION_URL}">machinaut-pr-action</a>; updates in place on re-runs.</sub>`
  )
}

function abbrevDigest(d: string): string {
  const hex = d.startsWith("sha256:") ? d.slice(7) : d
  return `sha256:${hex.slice(0, 12)}…`
}

/** Inline code span that server-supplied text cannot break out of. */
export function code(s: string): string {
  let longest = 0
  let run = 0
  for (const ch of s) {
    run = ch === "`" ? run + 1 : 0
    if (run > longest) longest = run
  }
  const fence = "`".repeat(longest + 1)
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : ""
  return `${fence}${pad}${s}${pad}${fence}`
}

/** Backslash-escape markdown/HTML punctuation in server-derived prose (ids
 *  inside reasons), so a crafted id cannot inject links, HTML or formatting. */
export function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()<>#+!|~]/g, (c) => `\\${c}`)
}
