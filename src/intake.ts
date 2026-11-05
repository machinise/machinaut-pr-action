import type { SerializedBundle } from "@actions/attest"

/**
 * SEAM for Track G slice G2 (planned): hand the signed bundle to Machinaut so the
 * console can verify it (with `@sigstore/verify`, against a per-project pinned
 * signer identity) and DISPLAY the result next to the session — display only,
 * never authority: the signature already verifies without Machinaut
 * (`gh attestation verify`).
 *
 * G2's intake will be `POST {api-url}/v1/projects/:p/sessions/:s/attestations`
 * (project key; body = the Sigstore bundle; size-capped; deduped on bundle
 * digest). That endpoint does not exist yet, so in this slice this function makes
 * NO network call — it only reports that intake is planned. When G2 ships, the
 * request goes here, behind an opt-in input, and `main` needs no other change.
 */
export interface IntakeRequest {
  apiUrl: string
  apiKey: string
  projectId: string
  sessionId: string
  bundle: SerializedBundle
}

export type IntakeResult = { submitted: false; reason: "planned"; message: string }

export async function submitBundleToIntake(_req: IntakeRequest): Promise<IntakeResult> {
  return {
    submitted: false,
    reason: "planned",
    message:
      "Machinaut attestation intake (Track G, G2) is planned — the bundle was not sent to Machinaut; " +
      "it is verifiable today with `gh attestation verify`",
  }
}
