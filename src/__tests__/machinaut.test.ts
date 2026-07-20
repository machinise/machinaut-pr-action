import { describe, expect, it, vi } from "vitest"
import { fetchSessionReport, MachinautApiError, normalizeBaseUrl } from "../machinaut"

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const OK_BODY = {
  projection: { event_count: 3, actor_ids: ["a"], actions: [] },
  report_markdown: "# Lodestar trust report",
}

describe("normalizeBaseUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeBaseUrl("https://console.machinaut.ai/")).toBe("https://console.machinaut.ai")
    expect(normalizeBaseUrl("https://x.example/base///")).toBe("https://x.example/base")
  })
  it("rejects non-http(s) and invalid URLs", () => {
    expect(() => normalizeBaseUrl("ftp://x")).toThrow(/http\(s\)/)
    expect(() => normalizeBaseUrl("not a url")).toThrow()
  })
})

describe("fetchSessionReport", () => {
  it("calls the report endpoint with a Bearer key and report=1", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, OK_BODY))
    const out = await fetchSessionReport(
      { apiUrl: "https://console.machinaut.ai", apiKey: "sk_test", projectId: "demo", sessionId: "sess-demo" },
      { fetch: fetchMock as unknown as typeof fetch },
    )
    expect(out.projection.event_count).toBe(3)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://console.machinaut.ai/v1/projects/demo/sessions/sess-demo?report=1")
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk_test")
  })

  it("percent-encodes path segments", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, OK_BODY))
    await fetchSessionReport(
      { apiUrl: "https://x.example", apiKey: "k", projectId: "a/b", sessionId: "s d" },
      { fetch: fetchMock as unknown as typeof fetch },
    )
    expect(fetchMock.mock.calls[0]![0]).toBe("https://x.example/v1/projects/a%2Fb/sessions/s%20d?report=1")
  })

  it("throws a 404 MachinautApiError the caller can treat as skippable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(404, { error: "not_found", message: "no events" }))
    await expect(
      fetchSessionReport(
        { apiUrl: "https://x.example", apiKey: "k", projectId: "p", sessionId: "s" },
        { fetch: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ status: 404, code: "not_found" })
  })

  it("wraps 401 with the API's error code", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, { error: "invalid_credentials", message: "unknown API key" }))
    const err = await fetchSessionReport(
      { apiUrl: "https://x.example", apiKey: "bad", projectId: "p", sessionId: "s" },
      { fetch: fetchMock as unknown as typeof fetch },
    ).catch((e) => e)
    expect(err).toBeInstanceOf(MachinautApiError)
    expect(err.status).toBe(401)
    expect(err.message).toContain("invalid_credentials")
  })

  it("reports a network failure as a status-0 error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    await expect(
      fetchSessionReport(
        { apiUrl: "https://x.example", apiKey: "k", projectId: "p", sessionId: "s" },
        { fetch: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ status: 0, code: "network_error" })
  })
})
