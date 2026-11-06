import { X509Certificate } from "node:crypto"

/**
 * The identity a governed-run bundle was signed with, read off its own signing
 * certificate (issue #12).
 *
 * Fulcio puts the OIDC token's `job_workflow_ref` into the certificate's SAN URI:
 * `https://github.com/<owner>/<repo>/.github/workflows/<file>@<ref>`. For a job that
 * runs inside a REUSABLE workflow that names the reusable workflow — not the caller
 * named by `GITHUB_WORKFLOW_REF` — and it is what `gh attestation verify
 * --signer-workflow` and the Machinaut console's identity pin both match against.
 * So the verify recipe is derived from here, never guessed from the environment.
 */
export interface SignerIdentity {
  /** The certificate's SAN URI, verbatim — `<workflow URL>@<ref>`. */
  san: string
  /** The workflow file URL: the SAN before `@<ref>`. */
  workflowUrl: string
  /** The `gh attestation verify --signer-workflow` argument: `<owner>/<repo>/.github/workflows/<file>`
   *  (prefixed with the host when it is not github.com — gh's `[host/]` form). */
  signerWorkflow: string
  /** The git ref (or commit SHA) after `@` — e.g. `refs/heads/main`, `refs/pull/9/merge`. */
  ref: string
}

/**
 * `https://<host>/<owner>/<repo>/.github/workflows/<file>@<ref>`. The file may not
 * contain `/` or `@` (GitHub runs workflows only from `.github/workflows/` itself);
 * the ref is everything after the first `@` that follows the file. Control
 * characters, whitespace in the ref and backticks are refused outright: the result
 * is pasted into a fenced shell recipe in a PR comment.
 */
const WORKFLOW_SAN =
  /^https:\/\/([A-Za-z0-9.-]+(?::[0-9]{1,5})?)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(\.github\/workflows\/[^/@\x00-\x1f\x7f`]+)@([^\s\x00-\x1f\x7f`]+)$/

/** The bundle's leaf (signing) certificate as DER, or undefined (key-signed or malformed). */
export function leafCertificateDer(bundle: unknown): Buffer | undefined {
  const vm = (bundle as { verificationMaterial?: unknown } | null | undefined)?.verificationMaterial as
    | { certificate?: { rawBytes?: unknown }; x509CertificateChain?: { certificates?: Array<{ rawBytes?: unknown }> } }
    | null
    | undefined
  if (!vm || typeof vm !== "object") return undefined
  // Bundle v0.3 carries the leaf alone; v0.1/v0.2 carry a chain whose first entry is the leaf.
  const raw = vm.certificate?.rawBytes ?? vm.x509CertificateChain?.certificates?.[0]?.rawBytes
  if (typeof raw !== "string" || raw === "") return undefined
  const der = Buffer.from(raw, "base64")
  return der.length > 0 ? der : undefined
}

/**
 * The signer identity from the bundle's signing certificate, or undefined when the
 * bundle has no certificate, it does not parse, or its SAN is not a GitHub Actions
 * workflow URI. Never throws.
 */
export function signerIdentityFromBundle(bundle: unknown): SignerIdentity | undefined {
  const der = leafCertificateDer(bundle)
  if (!der) return undefined
  let san: string | undefined
  try {
    san = new X509Certificate(der).subjectAltName
  } catch {
    return undefined
  }
  for (const uri of sanUris(san)) {
    const identity = parseWorkflowSan(uri)
    if (identity) return identity
  }
  return undefined
}

/** Split a SAN URI into the workflow and the ref; undefined unless it is a workflow URI. */
export function parseWorkflowSan(san: string): SignerIdentity | undefined {
  const m = WORKFLOW_SAN.exec(san)
  if (!m) return undefined
  const [, host, owner, repo, path, ref] = m as unknown as [string, string, string, string, string, string]
  const workflow = `${owner}/${repo}/${path}`
  return {
    san,
    workflowUrl: `https://${host}/${workflow}`,
    signerWorkflow: host.toLowerCase() === "github.com" ? workflow : `${host}/${workflow}`,
    ref,
  }
}

/**
 * The `URI:` entries of Node's `X509Certificate.subjectAltName` string. Entries are
 * `TYPE:value` joined by `", "`; Node writes a value that contains `,` `"` `\` `'`
 * or a control character as a JSON string literal, so a comma inside a URI cannot be
 * mistaken for a separator.
 */
export function sanUris(subjectAltName: string | undefined): string[] {
  const out: string[] = []
  if (!subjectAltName) return out
  let i = 0
  const s = subjectAltName
  while (i < s.length) {
    const colon = s.indexOf(":", i)
    if (colon === -1) break
    const type = s.slice(i, colon)
    let value: string
    let next: number
    if (s[colon + 1] === '"') {
      // A JSON string literal: find its closing quote, honouring backslash escapes.
      let j = colon + 2
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1
      try {
        value = JSON.parse(s.slice(colon + 1, j + 1)) as string
      } catch {
        return out
      }
      next = j + 1
    } else {
      const sep = s.indexOf(", ", colon + 1)
      value = sep === -1 ? s.slice(colon + 1) : s.slice(colon + 1, sep)
      next = sep === -1 ? s.length : sep
    }
    if (type === "URI") out.push(value)
    // Skip the ", " separator.
    i = s.startsWith(", ", next) ? next + 2 : s.length
  }
  return out
}
