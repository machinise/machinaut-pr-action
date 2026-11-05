import { describe, expect, it, vi } from "vitest"
import { BUNDLE_CONTENT_TYPE, submitBundleToIntake } from "../intake"

const req = {
  apiUrl: "https://console.machinaut.ai/",
  apiKey: "sk_test",
  projectId: "demo",
  sessionId: "sess/1",
  bundle: { mediaType: "sigstore-bundle" } as never,
}
const res = (status: number, body?: unknown) => new Response(body === undefined ? "" : JSON.stringify(body), { status })
const run = (f: ReturnType<typeof vi.fn>) => submitBundleToIntake(req, { fetch: f as unknown as typeof fetch })

describe("submitBundleToIntake", () => {
  it("POSTs the bundle JSON verbatim with bearer auth and the sigstore content type", async () => {
    const f = vi.fn().mockResolvedValue(res(201, {}))
    const r = await run(f)
    expect(r).toMatchObject({ outcome: "recorded", status: 201 })
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe("https://console.machinaut.ai/v1/projects/demo/sessions/sess%2F1/attestations")
    expect(init.method).toBe("POST")
    expect(init.headers.authorization).toBe("Bearer sk_test")
    expect(init.headers["content-type"]).toBe(BUNDLE_CONTENT_TYPE)
    expect(init.body).toBe('{"mediaType":"sigstore-bundle"}')
  })

  it.each([
    [200, "recorded"],
    [404, "not_available"],
    [401, "rejected"],
    [403, "rejected"],
    [409, "rejected"],
    [413, "rejected"],
    [500, "failed"],
    [422, "failed"],
  ])("HTTP %i -> %s", async (status, outcome) => {
    const r = await run(vi.fn().mockResolvedValue(res(status, { error: "bundle_exists" })))
    expect(r.outcome).toBe(outcome)
    if (status === 409) expect(r.code).toBe("bundle_exists")
    if (outcome === "failed") expect(r.status).toBe(status)
  })

  it("falls back to application/json on a 415", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(415, {})).mockResolvedValueOnce(res(200, {}))
    const r = await run(f)
    expect(r.outcome).toBe("recorded")
    expect(f).toHaveBeenCalledTimes(2)
    expect(f.mock.calls[1]![1].headers["content-type"]).toBe("application/json")
  })

  it("retries once on a network error, recovering if the retry works", async () => {
    const f = vi.fn().mockRejectedValueOnce(new Error("reset")).mockResolvedValueOnce(res(200, {}))
    expect((await run(f)).outcome).toBe("recorded")
    expect(f).toHaveBeenCalledTimes(2)
  })

  it("a network error after the 415 fallback still gets the single retry", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(415, {})).mockRejectedValueOnce(new Error("reset")).mockResolvedValueOnce(res(201, {}))
    expect((await run(f)).outcome).toBe("recorded")
    expect(f).toHaveBeenCalledTimes(3)
    expect(f.mock.calls[2]![1].headers["content-type"]).toBe("application/json")
  })

  it("gives up after one retry and never throws", async () => {
    const f = vi.fn().mockRejectedValue(new Error("down"))
    const r = await run(f)
    expect(r).toMatchObject({ outcome: "failed", status: 0 })
    expect(f).toHaveBeenCalledTimes(2)
  })

  it("does not retry on HTTP errors", async () => {
    const f = vi.fn().mockResolvedValue(res(500, {}))
    await run(f)
    expect(f).toHaveBeenCalledTimes(1)
  })
})
