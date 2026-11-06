import { describe, expect, it, vi } from "vitest"
import { isForkPullRequest } from "../events"
import { githubStore, planSigning, SigningError, signStatement } from "../signing"
import { buildStatement } from "../statement"
import { bundleV03, keySignedBundle, REUSABLE_SAN, selfSignedCert } from "./fixtures/cert"
import { HEAD_SHA, summary } from "./fixtures/summary"

const OIDC = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t" }
const sameRepoPr = { pull_request: { head: { repo: { full_name: "acme/widgets" } }, base: { repo: { full_name: "acme/widgets" } } } }
const forkPr = { pull_request: { head: { repo: { full_name: "mallory/widgets" } }, base: { repo: { full_name: "acme/widgets" } } } }

describe("isForkPullRequest", () => {
  it("detects a pull_request whose head repo differs from the base", () => {
    expect(isForkPullRequest(forkPr, "pull_request")).toBe(true)
    expect(isForkPullRequest(sameRepoPr, "pull_request")).toBe(false)
  })
  it("treats a deleted fork (head.repo null) as a fork", () => {
    expect(isForkPullRequest({ pull_request: { head: { repo: null }, base: { repo: { full_name: "a/b" } } } }, "pull_request")).toBe(true)
  })
  it("does not restrict pull_request_target or non-PR events", () => {
    expect(isForkPullRequest(forkPr, "pull_request_target")).toBe(false)
    expect(isForkPullRequest(forkPr, "push")).toBe(false)
    expect(isForkPullRequest({}, "pull_request")).toBe(false)
  })
  it("compares repo names case-insensitively", () => {
    expect(
      isForkPullRequest({ pull_request: { head: { repo: { full_name: "Acme/Widgets" } }, base: { repo: { full_name: "acme/widgets" } } } }, "pull_request"),
    ).toBe(false)
  })
})

describe("planSigning — skips are explicit, never silent", () => {
  it("signs on a same-repo PR with an OIDC token available", () => {
    expect(planSigning({ dryRun: false, eventName: "pull_request", payload: sameRepoPr, env: OIDC })).toEqual({ sign: true })
  })
  it("dry-run wins over everything", () => {
    const p = planSigning({ dryRun: true, eventName: "pull_request", payload: forkPr, env: {} })
    expect(p).toMatchObject({ sign: false, reason: "dry-run" })
  })
  it("fork PRs are skipped (no OIDC for forks)", () => {
    const p = planSigning({ dryRun: false, eventName: "pull_request", payload: forkPr, env: OIDC })
    expect(p).toMatchObject({ sign: false, reason: "fork" })
  })
  it("missing id-token: write is skipped with a fix-it message", () => {
    const p = planSigning({ dryRun: false, eventName: "pull_request", payload: sameRepoPr, env: { ACTIONS_ID_TOKEN_REQUEST_URL: "x" } })
    expect(p).toMatchObject({ sign: false, reason: "permissions" })
    expect(p.sign === false && p.detail).toMatch(/id-token: write.*attestations: write/)
  })
})

describe("signStatement (@actions/attest mocked)", () => {
  const statement = buildStatement({
    owner: "acme",
    repo: "widgets",
    headSha: HEAD_SHA,
    summary: summary(),
    policy: { require_holds_resolved: true, require_bound_approvals: false, max_sentinel_severity: "warning", allow_unreadable: false },
    decision: "pass",
    reasons: [],
  })
  const bundle = { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json" } as never
  const opts = { token: "ghs_x", serverUrl: "https://github.com", owner: "acme", repo: "widgets" }

  it("hands the toolkit exactly the statement's subjects, predicate type and predicate", async () => {
    const attest = vi.fn().mockResolvedValue({ bundle, certificate: "pem", tlogID: "12345" })
    const store = vi.fn().mockResolvedValue(987)
    const res = await signStatement(statement, { attest, store }, opts)
    expect(attest).toHaveBeenCalledWith({
      subjects: statement.subject,
      predicateType: "https://machinaut.ai/attestation/governed-run/v1",
      predicate: statement.predicate,
      token: "ghs_x",
      skipWrite: true,
    })
    expect(store).toHaveBeenCalledWith(bundle)
    expect(res).toEqual({
      bundle,
      tlogId: "12345",
      attestationId: "987",
      attestationUrl: "https://github.com/acme/widgets/attestations/987",
    })
  })

  it("keeps the signed bundle and reports honestly when GitHub refuses to store it", async () => {
    const attest = vi.fn().mockResolvedValue({ bundle, certificate: "pem" })
    const store = vi.fn().mockRejectedValue(Object.assign(new Error("Resource not accessible by integration"), { status: 403 }))
    const res = await signStatement(statement, { attest, store }, opts)
    expect(res.bundle).toBe(bundle)
    expect(res.attestationUrl).toBeUndefined()
    expect(res.storeError).toBe("HTTP 403: Resource not accessible by integration")
  })

  it("reads the signer identity off the signed bundle's own certificate", async () => {
    const signedBundle = bundleV03(selfSignedCert([{ uri: REUSABLE_SAN }]))
    const attest = vi.fn().mockResolvedValue({ bundle: signedBundle, certificate: "pem" })
    const res = await signStatement(statement, { attest, store: vi.fn().mockResolvedValue(1) }, opts)
    expect(res.signer).toEqual({
      san: REUSABLE_SAN,
      workflowUrl: "https://github.com/acme/shared-workflows/.github/workflows/governed-run.yml",
      signerWorkflow: "acme/shared-workflows/.github/workflows/governed-run.yml",
      ref: "refs/heads/main",
    })
  })

  it("leaves the signer unset when the bundle carries no certificate", async () => {
    const attest = vi.fn().mockResolvedValue({ bundle: keySignedBundle(), certificate: "" })
    const res = await signStatement(statement, { attest, store: vi.fn().mockResolvedValue(1) }, opts)
    expect(res).not.toHaveProperty("signer")
  })

  it("raises a SigningError (never a silent pass) when signing itself fails", async () => {
    const attest = vi.fn().mockRejectedValue(new Error("Error retrieving OIDC token"))
    const store = vi.fn()
    await expect(signStatement(statement, { attest, store }, opts)).rejects.toThrow(SigningError)
    await expect(signStatement(statement, { attest, store }, opts)).rejects.toThrow(/Sigstore signing failed: Error retrieving OIDC token/)
    expect(store).not.toHaveBeenCalled()
  })
})

describe("githubStore", () => {
  it("POSTs the bundle to the repo's attestation store and returns the id", async () => {
    const request = vi.fn().mockResolvedValue({ data: { id: 42 } })
    const id = await githubStore({ request }, "acme", "widgets")({ some: "bundle" } as never)
    expect(id).toBe(42)
    expect(request).toHaveBeenCalledWith("POST /repos/{owner}/{repo}/attestations", {
      owner: "acme",
      repo: "widgets",
      data: { bundle: { some: "bundle" } },
    })
  })
  it("tolerates a string response body", async () => {
    const request = vi.fn().mockResolvedValue({ data: '{"id":"7"}' })
    expect(await githubStore({ request }, "a", "b")({} as never)).toBe("7")
  })
})
