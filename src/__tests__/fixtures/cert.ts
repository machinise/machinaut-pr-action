import { generateKeyPairSync, sign } from "node:crypto"

/**
 * A minimal DER builder for a real, parseable, self-signed X.509 v3 certificate
 * shaped like a Fulcio leaf: empty subject, an ECDSA P-256 key, and a critical
 * subjectAltName — so tests exercise `node:crypto`'s X509Certificate on actual
 * certificate bytes, not a mock.
 */

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content)
  return Buffer.concat([Buffer.from([tag]), len(body.length), body])
}

const seq = (...c: Buffer[]) => tlv(0x30, ...c)
const set = (...c: Buffer[]) => tlv(0x31, ...c)

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number) as [number, number, ...number[]]
  const out = [40 * a + b]
  for (const n of rest) {
    const chunk: number[] = [n & 0x7f]
    for (let v = n >>> 7; v > 0; v >>>= 7) chunk.unshift((v & 0x7f) | 0x80)
    out.push(...chunk)
  }
  return tlv(0x06, Buffer.from(out))
}

const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"))
const utcTime = (s: string) => tlv(0x17, Buffer.from(s, "ascii"))

export type SanEntry = { uri: string } | { email: string }

function generalName(e: SanEntry): Buffer {
  // [6] uniformResourceIdentifier / [1] rfc822Name, both IMPLICIT IA5String.
  return "uri" in e ? tlv(0x86, Buffer.from(e.uri, "ascii")) : tlv(0x81, Buffer.from(e.email, "ascii"))
}

/** DER bytes of a self-signed certificate carrying `san` (omit it for no SAN extension). */
export function selfSignedCert(san: SanEntry[] = []): Buffer {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"))
  const issuer = seq(set(seq(oid("2.5.4.10"), utf8("sigstore.dev"))), set(seq(oid("2.5.4.3"), utf8("sigstore-intermediate"))))
  const extensions =
    san.length === 0
      ? []
      : [
          tlv(
            0xa3,
            seq(seq(oid("2.5.29.17"), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq(...san.map(generalName))))),
          ),
        ]
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([0x02]))), // v3
    tlv(0x02, Buffer.from([0x12, 0x34, 0x56])),
    ecdsaSha256,
    issuer,
    seq(utcTime("261106100000Z"), utcTime("261106101000Z")),
    seq(), // empty subject, like a Fulcio leaf
    publicKey.export({ type: "spki", format: "der" }),
    ...extensions,
  )
  const signature = sign("sha256", tbs, privateKey)
  return seq(tbs, ecdsaSha256, tlv(0x03, Buffer.concat([Buffer.from([0x00]), signature])))
}

/** A Sigstore bundle v0.3 as `@actions/attest` returns it, signed by `certDer`. */
export function bundleV03(certDer: Buffer): Record<string, unknown> {
  return {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: {
      certificate: { rawBytes: certDer.toString("base64") },
      tlogEntries: [],
      timestampVerificationData: { rfc3161Timestamps: [] },
    },
    dsseEnvelope: { payload: "e30=", payloadType: "application/vnd.in-toto+json", signatures: [{ sig: "c2ln", keyid: "" }] },
  }
}

/** A v0.1/v0.2-style bundle: the leaf is the first entry of `x509CertificateChain`. */
export function bundleV02(certDer: Buffer, ...rest: Buffer[]): Record<string, unknown> {
  return {
    mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2",
    verificationMaterial: {
      x509CertificateChain: { certificates: [certDer, ...rest].map((c) => ({ rawBytes: c.toString("base64") })) },
      tlogEntries: [],
    },
    dsseEnvelope: { payload: "e30=", payloadType: "application/vnd.in-toto+json", signatures: [{ sig: "c2ln", keyid: "" }] },
  }
}

/** A key-signed bundle: no certificate at all. */
export function keySignedBundle(): Record<string, unknown> {
  return {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: { publicKey: { hint: "abc" }, tlogEntries: [] },
    dsseEnvelope: { payload: "e30=", payloadType: "application/vnd.in-toto+json", signatures: [{ sig: "c2ln", keyid: "abc" }] },
  }
}

/** The SAN Fulcio would issue for a job inside a reusable workflow. */
export const REUSABLE_SAN = "https://github.com/acme/shared-workflows/.github/workflows/governed-run.yml@refs/heads/main"
/** …while GITHUB_WORKFLOW_REF names the CALLER. */
export const CALLER_WORKFLOW_REF = "acme/widgets/.github/workflows/ci.yml@refs/pull/7/merge"
