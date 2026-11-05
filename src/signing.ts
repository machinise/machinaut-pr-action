import type { Attestation, AttestOptions, SerializedBundle } from "@actions/attest"
import { type ForkPayload, isForkPullRequest } from "./events"
import type { Statement } from "./statement"

/**
 * Signing the governed-run statement — the customer's act, never Machinaut's
 * (plan §2.1, ADR-0001). The signature is Sigstore keyless, made with THIS
 * workflow's GitHub OIDC identity through the `@actions/attest` toolkit; there is
 * no key to hold and no managed-tier signing.
 *
 * Signing is skipped — visibly, in the log, the outputs and the PR comment — in
 * exactly three cases. Anything that goes wrong after we decide to sign is a
 * signing FAILURE, reported as such and never passed off as success.
 */
export type SkipReason = "dry-run" | "fork" | "permissions"

export type SigningPlan = { sign: true } | { sign: false; reason: SkipReason; detail: string }

export function planSigning(args: {
  dryRun: boolean
  eventName: string | undefined
  payload: ForkPayload
  env: Record<string, string | undefined>
}): SigningPlan {
  if (args.dryRun) {
    return { sign: false, reason: "dry-run", detail: "dry-run is true — the statement was built but not signed" }
  }
  if (isForkPullRequest(args.payload, args.eventName)) {
    return {
      sign: false,
      reason: "fork",
      detail: "this is a pull_request from a fork — GitHub gives fork PR runs no OIDC token, so there is nothing to sign with",
    }
  }
  // `@sigstore/sign`'s CI identity provider reads exactly these two variables;
  // the runner only sets them when the job grants `id-token: write`.
  if (!args.env.ACTIONS_ID_TOKEN_REQUEST_URL || !args.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    return {
      sign: false,
      reason: "permissions",
      detail:
        "the job does not grant `id-token: write`, so no OIDC token is available — add `id-token: write` " +
        "and `attestations: write` to the job's permissions",
    }
  }
  return { sign: true }
}

export type AttestFn = (options: AttestOptions) => Promise<Attestation>

/** Persist a bundle to the repo's GitHub attestation store; resolves to its id. */
export type StoreFn = (bundle: SerializedBundle) => Promise<string | number | undefined>

export interface SignResult {
  bundle: SerializedBundle
  /** Rekor log index (public-good Sigstore only; private repos use GitHub's instance). */
  tlogId?: string
  /** GitHub attestation id, when the store accepted it. */
  attestationId?: string
  attestationUrl?: string
  /** Set when the signature exists but GitHub would not store the attestation
   *  (the raw GitHub error; see {@link STORE_HINT}). */
  storeError?: string
}

/** Why a store usually fails — appended wherever a store error is reported. */
export const STORE_HINT =
  "storing needs `attestations: write`, and GitHub artifact attestations need a public repository " +
  "or GitHub Enterprise Cloud"

/** Signing itself failed — no bundle exists. */
export class SigningError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SigningError"
  }
}

/**
 * Sign `statement` with Sigstore keyless, then store it in the repo's GitHub
 * attestation store.
 *
 * `attest()` is called with `skipWrite: true` and the store is a separate step,
 * so a storage refusal (missing `attestations: write`, or a private repo on a plan
 * without artifact attestations) still leaves the signed bundle on disk for
 * offline `gh attestation verify --bundle` — and is reported as "signed, not
 * stored" instead of losing the signature behind one opaque error.
 *
 * The toolkit rebuilds the in-toto Statement from `subjects` + `predicateType` +
 * `predicate` exactly as {@link buildStatement} does, so what it signs is
 * byte-identical to the statement file this action writes.
 */
export async function signStatement(
  statement: Statement,
  deps: { attest: AttestFn; store: StoreFn },
  opts: { token: string; serverUrl: string; owner: string; repo: string },
): Promise<SignResult> {
  let attestation: Attestation
  try {
    attestation = await deps.attest({
      subjects: statement.subject,
      predicateType: statement.predicateType,
      predicate: statement.predicate,
      token: opts.token,
      skipWrite: true,
    })
  } catch (err) {
    throw new SigningError(`Sigstore signing failed: ${errMessage(err)}`)
  }

  const result: SignResult = { bundle: attestation.bundle }
  if (attestation.tlogID) result.tlogId = attestation.tlogID

  try {
    const id = await deps.store(attestation.bundle)
    if (id !== undefined && id !== null && String(id) !== "") {
      result.attestationId = String(id)
      result.attestationUrl = `${opts.serverUrl.replace(/\/+$/, "")}/${opts.owner}/${opts.repo}/attestations/${result.attestationId}`
    }
  } catch (err) {
    const status = (err as { status?: number } | null)?.status
    result.storeError = `${status ? `HTTP ${status}: ` : ""}${errMessage(err)}`
  }
  return result
}

/** The minimal Octokit surface the default {@link StoreFn} needs. */
export interface AttestationStoreApi {
  request: (route: string, params: Record<string, unknown>) => Promise<{ data: unknown }>
}

/** `POST /repos/{owner}/{repo}/attestations` — the same call the toolkit's own
 *  store makes when `skipWrite` is false. */
export function githubStore(octokit: AttestationStoreApi, owner: string, repo: string): StoreFn {
  return async (bundle) => {
    const res = await octokit.request("POST /repos/{owner}/{repo}/attestations", {
      owner,
      repo,
      data: { bundle },
    })
    const data = typeof res.data === "string" ? (JSON.parse(res.data) as unknown) : res.data
    return (data as { id?: string | number } | null)?.id
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
