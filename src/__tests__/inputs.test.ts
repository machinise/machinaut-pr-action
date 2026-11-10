import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseBooleanInput, parseMode, parseSeverity, readInputs } from "../inputs"

/** `@actions/core.getInput(name)` reads `INPUT_<NAME>` (spaces → `_`, upper-cased). */
function setInput(name: string, value: string): void {
  process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] = value
}

const SAVED = { ...process.env }
beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("INPUT_")) delete process.env[k]
  setInput("machinaut-api-key", "sk")
  setInput("project-id", "demo")
  setInput("session-id", "sess")
})
afterEach(() => {
  process.env = { ...SAVED }
})

describe("parseBooleanInput", () => {
  it("falls back on empty, accepts the YAML core booleans, rejects anything else", () => {
    expect(parseBooleanInput("x", "", true)).toBe(true)
    expect(parseBooleanInput("x", "  ", false)).toBe(false)
    expect(parseBooleanInput("x", "TRUE", false)).toBe(true)
    expect(parseBooleanInput("x", "False", true)).toBe(false)
    expect(() => parseBooleanInput("fail-on-error", "yes", false)).toThrow(/YAML 1.2 "Core Schema".*fail-on-error/s)
  })
})

describe("parseMode / parseSeverity", () => {
  it("mode defaults to comment and accepts gate", () => {
    expect(parseMode("")).toBe("comment")
    expect(parseMode("comment")).toBe("comment")
    expect(parseMode("Gate")).toBe("gate")
    expect(() => parseMode("enforce")).toThrow(/'comment' or 'gate'/)
  })
  it("severity defaults to warning", () => {
    expect(parseSeverity("")).toBe("warning")
    expect(parseSeverity("info")).toBe("info")
    expect(parseSeverity("critical")).toBe("critical")
    expect(() => parseSeverity("error")).toThrow(/'info', 'warning' or 'critical'/)
  })
})

describe("readInputs", () => {
  it("comment mode (default): fail-on-error keeps v1's false default", () => {
    const i = readInputs()
    expect(i.mode).toBe("comment")
    expect(i.failOnError).toBe(false)
    expect(i.dryRun).toBe(false)
  })

  it("comment mode ignores gate-only inputs, even malformed ones", () => {
    setInput("max-sentinel-severity", "bogus")
    setInput("dry-run", "maybe")
    expect(() => readInputs()).not.toThrow()
  })

  it("comment mode still honours an explicit fail-on-error", () => {
    setInput("fail-on-error", "true")
    expect(readInputs().failOnError).toBe(true)
  })

  it("gate mode: fails closed by default and reads the D5 policy defaults", () => {
    setInput("mode", "gate")
    const i = readInputs()
    expect(i.mode).toBe("gate")
    expect(i.failOnError).toBe(true)
    expect(i.policy).toEqual({
      requireHoldsResolved: true,
      requireBoundApprovals: false,
      maxSentinelSeverity: "warning",
      allowUnreadable: false,
    })
    expect(i.dryRun).toBe(false)
  })

  it("gate mode: reads explicit policy inputs and an explicit fail-open", () => {
    setInput("mode", "gate")
    setInput("fail-on-error", "false")
    setInput("require-holds-resolved", "false")
    setInput("require-bound-approvals", "true")
    setInput("max-sentinel-severity", "info")
    setInput("dry-run", "true")
    setInput("allow-unreadable", "true")
    const i = readInputs()
    expect(i.failOnError).toBe(false)
    expect(i.policy).toEqual({
      requireHoldsResolved: false,
      requireBoundApprovals: true,
      maxSentinelSeverity: "info",
      allowUnreadable: true,
    })
    expect(i.dryRun).toBe(true)
  })

  it("gate mode: rejects a malformed policy input loudly", () => {
    setInput("mode", "gate")
    setInput("max-sentinel-severity", "bogus")
    expect(() => readInputs()).toThrow(/max-sentinel-severity/)
  })
})

describe("readInputs — machinaut-publish-token (planned)", () => {
  it("is empty and masks nothing when not supplied", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      expect(readInputs().publishToken).toBe("")
      expect(write.mock.calls.map((c) => String(c[0])).join("")).not.toContain("::add-mask::")
    } finally {
      write.mockRestore()
    }
  })

  it("is read, trimmed and masked as soon as it is read (comment and gate mode)", () => {
    for (const mode of ["comment", "gate"]) {
      setInput("mode", mode)
      setInput("machinaut-publish-token", "  mp_secret_value  ")
      const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
      try {
        expect(readInputs().publishToken).toBe("mp_secret_value")
        expect(write.mock.calls.map((c) => String(c[0])).join("")).toContain("::add-mask::mp_secret_value")
      } finally {
        write.mockRestore()
      }
    }
  })
})
