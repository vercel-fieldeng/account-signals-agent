import { describe, expect, it } from "vitest"
import { isPendingDiagnosticMessage, isTerminalDiagnosticMessage } from "../../agent/hooks/autonomous-diagnostic"

describe("autonomous diagnostic lifecycle", () => {
  it("does not reconcile interim tool-call messages", () => {
    expect(isTerminalDiagnosticMessage("tool-calls")).toBe(false)
  })

  it("reconciles final and unspecified message completions", () => {
    expect(isTerminalDiagnosticMessage("stop")).toBe(true)
    expect(isTerminalDiagnosticMessage(undefined)).toBe(true)
  })

  it("keeps pending d0 messages resumable", () => {
    expect(isPendingDiagnosticMessage("Status: WAITING_FOR_D0")).toBe(true)
    expect(isPendingDiagnosticMessage("Status: WAITING_FOR_CONTEXT")).toBe(true)
    expect(isPendingDiagnosticMessage("Signal retrieval is still processing")).toBe(true)
    expect(isPendingDiagnosticMessage("No signal brief yet—retrieval is still processing")).toBe(true)
    expect(isPendingDiagnosticMessage("Surfaced signals are complete")).toBe(false)
  })
})
