import { describe, expect, it } from "vitest"
import { leafCertificateDer, parseWorkflowSan, sanUris, signerIdentityFromBundle } from "../signerIdentity"
import { bundleV02, bundleV03, keySignedBundle, REUSABLE_SAN, selfSignedCert } from "./fixtures/cert"

describe("signerIdentityFromBundle — the identity comes from the signing certificate", () => {
  it("reads a reusable workflow's SAN from a v0.3 bundle's leaf certificate", () => {
    const bundle = bundleV03(selfSignedCert([{ uri: REUSABLE_SAN }]))
    expect(signerIdentityFromBundle(bundle)).toEqual({
      san: REUSABLE_SAN,
      workflowUrl: "https://github.com/acme/shared-workflows/.github/workflows/governed-run.yml",
      signerWorkflow: "acme/shared-workflows/.github/workflows/governed-run.yml",
      ref: "refs/heads/main",
    })
  })

  it("reads the FIRST certificate of a v0.1/v0.2 chain (the leaf), not the CA after it", () => {
    const leaf = selfSignedCert([{ uri: REUSABLE_SAN }])
    const ca = selfSignedCert([{ uri: "https://github.com/evil/repo/.github/workflows/x.yml@refs/heads/main" }])
    expect(signerIdentityFromBundle(bundleV02(leaf, ca))?.san).toBe(REUSABLE_SAN)
  })

  it("keeps the PR merge ref, a tag ref and a bare commit SHA as the ref", () => {
    for (const ref of ["refs/pull/9/merge", "refs/tags/v2.0.0", "0123456789abcdef0123456789abcdef01234567"]) {
      const san = `https://github.com/acme/widgets/.github/workflows/governed-run.yml@${ref}`
      expect(signerIdentityFromBundle(bundleV03(selfSignedCert([{ uri: san }])))).toMatchObject({
        san,
        signerWorkflow: "acme/widgets/.github/workflows/governed-run.yml",
        ref,
      })
    }
  })

  it("picks the workflow URI out of a multi-entry SAN", () => {
    const cert = selfSignedCert([{ email: "bot@example.com" }, { uri: "https://example.com/not-a-workflow" }, { uri: REUSABLE_SAN }])
    expect(signerIdentityFromBundle(bundleV03(cert))?.san).toBe(REUSABLE_SAN)
  })

  it("decodes a SAN Node had to quote (a comma in the file name)", () => {
    const san = "https://github.com/acme/widgets/.github/workflows/gate,v2.yml@refs/heads/main"
    expect(signerIdentityFromBundle(bundleV03(selfSignedCert([{ uri: san }])))).toMatchObject({
      san,
      signerWorkflow: "acme/widgets/.github/workflows/gate,v2.yml",
    })
  })

  it("prefixes a non-github.com host, in gh's `[host/]owner/repo/…` form", () => {
    const san = "https://acme.ghe.com/acme/widgets/.github/workflows/governed-run.yml@refs/heads/main"
    expect(signerIdentityFromBundle(bundleV03(selfSignedCert([{ uri: san }])))).toMatchObject({
      workflowUrl: "https://acme.ghe.com/acme/widgets/.github/workflows/governed-run.yml",
      signerWorkflow: "acme.ghe.com/acme/widgets/.github/workflows/governed-run.yml",
    })
  })

  it.each([
    ["a key-signed bundle (no certificate)", keySignedBundle()],
    ["a certificate without a SAN", bundleV03(selfSignedCert([]))],
    ["an email-only SAN", bundleV03(selfSignedCert([{ email: "me@example.com" }]))],
    ["a URI that is not a workflow", bundleV03(selfSignedCert([{ uri: "https://github.com/acme/widgets" }]))],
    ["bytes that are not a certificate", { verificationMaterial: { certificate: { rawBytes: Buffer.from("nope").toString("base64") } } }],
    ["empty rawBytes", { verificationMaterial: { certificate: { rawBytes: "" } } }],
    ["an empty chain", { verificationMaterial: { x509CertificateChain: { certificates: [] } } }],
    ["no verificationMaterial", { mediaType: "sigstore-bundle" }],
    ["null", null],
  ])("is undefined for %s — never a guess", (_label, bundle) => {
    expect(signerIdentityFromBundle(bundle)).toBeUndefined()
  })
})

describe("parseWorkflowSan", () => {
  it("refuses values that could break out of the fenced recipe", () => {
    expect(parseWorkflowSan("https://github.com/a/b/.github/workflows/x`y.yml@refs/heads/main")).toBeUndefined()
    expect(parseWorkflowSan("https://github.com/a/b/.github/workflows/x.yml@refs/heads/main\n```")).toBeUndefined()
    expect(parseWorkflowSan("https://github.com/a/b/.github/workflows/x.yml@refs/heads/ma in")).toBeUndefined()
  })
  it("needs a workflow file directly under .github/workflows and a ref", () => {
    expect(parseWorkflowSan("https://github.com/a/b/.github/workflows/x.yml")).toBeUndefined()
    expect(parseWorkflowSan("https://github.com/a/b/.github/workflows/@refs/heads/main")).toBeUndefined()
    expect(parseWorkflowSan("https://github.com/a/b/other/x.yml@refs/heads/main")).toBeUndefined()
    expect(parseWorkflowSan("http://github.com/a/b/.github/workflows/x.yml@refs/heads/main")).toBeUndefined()
  })
})

describe("sanUris — Node's subjectAltName string", () => {
  it("splits plain and quoted entries and keeps only URIs", () => {
    expect(sanUris('email:a@b.c, URI:"https://x/a\\u002cb", URI:https://y/z, DNS:example.com')).toEqual([
      "https://x/a,b",
      "https://y/z",
    ])
  })
  it("handles undefined and malformed input", () => {
    expect(sanUris(undefined)).toEqual([])
    expect(sanUris("")).toEqual([])
    expect(sanUris('URI:"unterminated')).toEqual([])
  })
})

describe("leafCertificateDer", () => {
  it("returns the v0.3 leaf certificate's DER bytes", () => {
    const cert = selfSignedCert([{ uri: REUSABLE_SAN }])
    expect(leafCertificateDer(bundleV03(cert))?.equals(cert)).toBe(true)
  })
})
