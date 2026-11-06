import { describe, expect, it } from "vitest"
import { STICKY_MARKER } from "../comment"
import { evaluateGate } from "../gate"
import {
  CANDOR_LINES,
  code,
  escapeMd,
  GATE_STICKY_MARKER,
  type GateCommentInput,
  renderGateComment,
  renderGateErrorComment,
  WORKFLOW_REF_FALLBACK_NOTE,
} from "../gateComment"
import { parseWorkflowSan } from "../signerIdentity"
import { REUSABLE_SAN } from "./fixtures/cert"
import { HEAD_SHA, summary } from "./fixtures/summary"

const POLICY = { require_holds_resolved: true, require_bound_approvals: false, max_sentinel_severity: "warning" as const, allow_unreadable: false }
const SESSION_URL = "https://console.machinaut.ai/projects/demo/sessions/sess-demo"

function render(overrides: Partial<GateCommentInput> = {}): string {
  const s = overrides.summary ?? summary()
  return renderGateComment({
    summary: s,
    result: evaluateGate(s, { requireHoldsResolved: true, requireBoundApprovals: false, maxSentinelSeverity: "warning", allowUnreadable: false }),
    policy: POLICY,
    dryRun: false,
    headSha: HEAD_SHA,
    sessionUrl: SESSION_URL,
    attestation: { kind: "signed", attestationUrl: "https://github.com/acme/widgets/attestations/1" },
    ...overrides,
  })
}

describe("renderGateComment", () => {
  const RECIPE =
    "gh attestation verify machinaut-governance-summary.json --repo acme/widgets " +
    "--predicate-type https://machinaut.ai/attestation/governed-run/v1 " +
    "--signer-workflow acme/widgets/.github/workflows/governed-run.yml"
  const verify = { repo: "acme/widgets", signerWorkflow: "acme/widgets/.github/workflows/governed-run.yml" }

  it("includes the exact verify recipe (one line) when signed, incl. signed-not-stored", () => {
    for (const attestation of [{ kind: "signed" as const }, { kind: "signed" as const, storeError: "HTTP 403" }]) {
      const body = render({ attestation, verify })
      const expected = attestation.storeError ? `${RECIPE} --bundle governed-run.sigstore.json` : RECIPE
      expect(body).toContain(`\`\`\`bash\n${expected}\n\`\`\``)
      expect(body).toContain("`machinaut-governed-run` artifact")
    }
  })

  describe("signer identity (issue #12)", () => {
    const signer = parseWorkflowSan(REUSABLE_SAN)!
    // GITHUB_WORKFLOW_REF names the caller; the certificate names the reusable workflow.
    const callerVerify = { repo: "acme/widgets", signer, signerWorkflow: "acme/widgets/.github/workflows/ci.yml" }

    it("uses the certificate's workflow for --signer-workflow, never the caller's", () => {
      const body = render({ verify: callerVerify })
      expect(body).toContain(
        "--signer-workflow acme/shared-workflows/.github/workflows/governed-run.yml\n```",
      )
      expect(body).not.toContain("workflows/ci.yml")
      expect(body).not.toContain(WORKFLOW_REF_FALLBACK_NOTE)
    })

    it("shows the SAN in the verdict block and says the console pin must equal it", () => {
      const body = render({ verify: callerVerify })
      expect(body).toContain(
        `**Signer identity:** \`${REUSABLE_SAN}\` — read from the signing certificate. ` +
          "Your Machinaut console's identity pin (beta) must equal it exactly: workflow " +
          "`https://github.com/acme/shared-workflows/.github/workflows/governed-run.yml`, ref `refs/heads/main`.",
      )
      // above the verify recipe, below the attestation line
      const at = body.indexOf("**Attestation:**")
      const id = body.indexOf("**Signer identity:**")
      expect(at).toBeGreaterThan(-1)
      expect(id).toBeGreaterThan(at)
      expect(body.indexOf("**Verify without Machinaut**")).toBeGreaterThan(id)
    })

    it("points a PR-merge ref at the console's refs/pull/*/merge pin", () => {
      const pr = parseWorkflowSan("https://github.com/acme/widgets/.github/workflows/governed-run.yml@refs/pull/9/merge")!
      expect(render({ verify: { repo: "acme/widgets", signer: pr } })).toContain(
        "ref `refs/pull/9/merge` (or `refs/pull/*/merge` to cover every PR).",
      )
    })

    it("fallback: no certificate → the workflow-ref derivation, labelled as such", () => {
      const body = render({ verify: { repo: "acme/widgets", signerWorkflow: "acme/widgets/.github/workflows/ci.yml" } })
      expect(body).toContain("--signer-workflow acme/widgets/.github/workflows/ci.yml\n```")
      expect(body).toContain(
        "`--signer-workflow` (derived from the workflow ref; may differ for reusable workflows): " +
          "the bundle carried no signing certificate to read it from.",
      )
      expect(body).not.toContain("**Signer identity:**")
    })

    it("neither: a visible placeholder, no fallback claim", () => {
      const body = render({ verify: { repo: "acme/widgets" } })
      expect(body).toContain("--signer-workflow <owner>/<repo>/.github/workflows/<workflow>.yml")
      expect(body).not.toContain(WORKFLOW_REF_FALLBACK_NOTE)
    })

    it("never shows a signer identity for an unsigned or failed run", () => {
      expect(render({ attestation: { kind: "skipped", reason: "dry-run", detail: "x" }, verify: callerVerify })).not.toContain(
        "Signer identity",
      )
      expect(render({ attestation: { kind: "failed", message: "x" }, verify: callerVerify })).not.toContain("Signer identity")
    })
  })

  it("shell-quotes an unusual workflow path", () => {
    const body = render({ verify: { repo: "acme/widgets", signerWorkflow: "acme/widgets/.github/workflows/a b$(x).yml" } })
    expect(body).toContain("--signer-workflow 'acme/widgets/.github/workflows/a b$(x).yml'")
  })

  it("omits the verify recipe when unsigned or failed", () => {
    expect(render({ attestation: { kind: "skipped", reason: "dry-run", detail: "x" }, verify })).not.toContain("gh attestation verify")
    expect(render({ attestation: { kind: "failed", message: "x" }, verify })).not.toContain("gh attestation verify")
  })

  it("uses its own sticky marker, distinct from comment mode's in both directions", () => {
    const body = render()
    expect(body.startsWith(GATE_STICKY_MARKER)).toBe(true)
    expect(body.includes(STICKY_MARKER)).toBe(false)
    expect(GATE_STICKY_MARKER.includes(STICKY_MARKER)).toBe(false)
    expect(STICKY_MARKER.includes(GATE_STICKY_MARKER)).toBe(false)
  })

  it("carries the verdict, the facts, the evidence link and a beta label", () => {
    const body = render()
    expect(body).toContain("machinaut / governed-run: **pass** <sup>beta</sup>")
    expect(body).toContain("`0123456789ab`")
    expect(body).toContain("facts as held by Machinaut at `2026-11-04T12:00:00.000Z`")
    expect(body).toContain("143 events · 139 readable · 4 redacted (commitment only) · seq 1–143")
    expect(body).toContain("2: 1 granted · 1 denied — evidence: 2 host record — 1 bound (ADR-0042) · 1 host-adjudicated quorum")
    expect(body).toContain("0 critical · 1 warning · 3 info")
    expect(body).toContain("| **Unreadable** | 0 approval request(s) · 0 sentinel alert(s) withheld by the shipper")
    expect(body).toContain("unreadable records: fail closed")
    expect(body).toContain(`[Open the evidence in Machinaut →](${SESSION_URL})`)
    expect(body).toContain("Sign-in required")
  })

  it("candor (plan §2.5): proves/does-not-prove, relay_only ≠ verified, Lodestar OSS, GitHub enforces", () => {
    const body = render()
    for (const line of CANDOR_LINES) expect(body).toContain(line)
    expect(body).toMatch(/does \*\*not\*\* prove the agent could not have misbehaved/)
    expect(body).toMatch(/that the event log is complete/)
    expect(body).toMatch(/`relay_only` hold is \*\*not\*\* a verified approval/)
    expect(body).toMatch(/attested by commitment, not content/)
    expect(body).toMatch(/Hash verification, approval-signature verification, quorum adjudication, redaction and sentinel detection are \[Lodestar\]\([^)]+\) OSS/)
    expect(body).toMatch(/GitHub enforces this check .* Machinaut cannot block a merge/)
    expect(body).toMatch(/the decision and the signature are made by this workflow, never by Machinaut/)
    expect(CANDOR_LINES).toHaveLength(2)
  })

  it("lists failure reasons, escaped", () => {
    const s = summary()
    s.holds[0]!.evidence = "relay_only"
    s.holds[0]!.request_id = "[click](https://evil.example)"
    const body = render({ summary: s })
    expect(body).toContain("machinaut / governed-run: **fail**")
    expect(body).toContain("**Why it failed:**")
    expect(body).toContain("\\[click\\]\\(https://evil.example\\)")
    expect(body).not.toContain("[click](https://evil.example)")
  })

  it.each([
    [{ kind: "skipped", reason: "dry-run", detail: "dry-run is true" }, "🚫 **unsigned (dry-run)**"],
    [{ kind: "skipped", reason: "fork", detail: "fork" }, "🚫 **unsigned (fork)**"],
    [{ kind: "skipped", reason: "permissions", detail: "grant id-token: write" }, "🚫 **unsigned (permissions)**"],
    [{ kind: "failed", message: "Sigstore signing failed: x" }, "❌ **signing failed**"],
    [{ kind: "signed", storeError: "HTTP 403: nope" }, "Signed, but **not stored** in GitHub"],
  ] as const)("labels the attestation state honestly: %o", (attestation, label) => {
    expect(render({ attestation: attestation as GateCommentInput["attestation"] })).toContain(label)
  })

  it("shows a truncated hold list and the notes allow-unreadable produced", () => {
    const s = summary()
    s.holds_truncated = true
    s.unreadable = { approval_requests: 0, sentinel_alerts: 2 }
    const result = evaluateGate(s, { requireHoldsResolved: false, requireBoundApprovals: false, maxSentinelSeverity: "warning", allowUnreadable: true })
    const body = render({ summary: s, result, policy: { ...POLICY, require_holds_resolved: false, allow_unreadable: true } })
    expect(body).toContain("**list truncated**")
    expect(body).toContain("**Not evaluated (allowed by policy):**")
    expect(body).toContain("2 sentinel alerts unreadable")
    expect(body).not.toContain("Why it failed")
    expect(body).toContain("unreadable records: allowed (stated, not evaluated)")
  })

  it("dry run says it is not enforced", () => {
    expect(render({ dryRun: true })).toContain("(dry run): would **pass** — not enforced")
  })

  it("error comment says no decision and nothing signed", () => {
    const body = renderGateErrorComment({ sessionUrl: SESSION_URL, message: "Machinaut returned 503", dryRun: false })
    expect(body.startsWith(GATE_STICKY_MARKER)).toBe(true)
    expect(body).toContain("could not evaluate")
    expect(body).toContain("no decision was made and nothing was signed")
  })
})

describe("markdown safety helpers", () => {
  it("code() picks a fence longer than any backtick run in the content", () => {
    expect(code("abc")).toBe("`abc`")
    expect(code("a`b")).toBe("``a`b``")
    expect(code("`x`")).toBe("`` `x` ``")
  })
  it("escapeMd() neutralises link/HTML/emphasis syntax", () => {
    expect(escapeMd("<img src=x>*_[a](b)|")).toBe("\\<img src=x\\>\\*\\_\\[a\\]\\(b\\)\\|")
  })
})
