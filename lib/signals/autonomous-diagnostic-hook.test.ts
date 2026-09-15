import { describe, expect, it } from "vitest"
import { isTerminalDiagnosticMessage } from "../../agent/hooks/autonomous-diagnostic"

describe("autonomous diagnostic lifecycle", () => {
  it("does not reconcile interim tool-call messages", () => {
    expect(isTerminalDiagnosticMessage("tool-calls")).toBe(false)
  })

  it("reconciles final and unspecified message completions", () => {
    expect(isTerminalDiagnosticMessage("stop")).toBe(true)
    expect(isTerminalDiagnosticMessage(undefined)).toBe(true)
  })
})
