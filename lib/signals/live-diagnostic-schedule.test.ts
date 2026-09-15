import { describe, expect, it, vi } from "vitest"
import { AUTOMATION_CHANNEL_ID, AUTOMATION_OPERATOR_USER_ID, AUTOMATION_WORKSPACE_ID } from "./automation-policy"

const channel = { name: "mock-slack" }
const runner = vi.fn()
const waits: Promise<unknown>[] = []

vi.mock("eve/schedules", () => ({ defineSchedule: (definition: unknown) => definition }))
vi.mock("../../agent/channels/slack", () => ({ default: channel }))
vi.mock("./autonomous-diagnostic", () => ({
  runAutonomousDiagnostic: runner,
}))

const { default: schedule } = await import("../../agent/schedules/live-diagnostic")
type ScheduleArgs = Parameters<typeof schedule.run>[0]
type TargetHandle = ReturnType<ScheduleArgs["to"]>
type Session = Awaited<ReturnType<TargetHandle["send"]>>
const appAuth: ScheduleArgs["appAuth"] = { authenticator: "app", principalId: "eve:app", principalType: "runtime", attributes: {} }
const session = { id: "session-1", send: vi.fn(), respond: vi.fn(), cancel: vi.fn(), compact: vi.fn(), close: vi.fn(), stream: vi.fn(), finish: vi.fn(), clear: vi.fn(), reset: vi.fn(), getEventStream: vi.fn(), getStreamTailIndex: vi.fn() } as unknown as Session
const owner = {
  auth: {
    authenticator: "slack-webhook",
    principalId: `slack:${AUTOMATION_WORKSPACE_ID}:${AUTOMATION_OPERATOR_USER_ID}`,
    principalType: "user",
    issuer: `slack:${AUTOMATION_WORKSPACE_ID}`,
    attributes: { user_id: AUTOMATION_OPERATOR_USER_ID, team_id: AUTOMATION_WORKSPACE_ID, channel_id: AUTOMATION_CHANNEL_ID, author_type: "user" },
  },
  channelId: AUTOMATION_CHANNEL_ID,
  installationTeamId: AUTOMATION_WORKSPACE_ID,
}

function reset() {
  runner.mockReset()
  waits.length = 0
}

describe("native owner-bound diagnostic schedule", () => {
  it("runs every minute", () => {
    expect(schedule.cron).toBe("* * * * *")
  })

  it("registers the complete runner promise, awaits it, and creates the target only when dispatch is called", async () => {
    const send = vi.fn(async () => session)
    const toMock = vi.fn(() => ({ send }))
    const to = toMock as ScheduleArgs["to"]
    let resolve!: () => void
    const gate = new Promise<void>((done) => { resolve = done })
    runner.mockImplementation(async (options: { dispatch: (actualOwner: typeof owner, prompt: string) => Promise<{ id: string }> }) => {
      await gate
      return options.dispatch(owner, "diagnostic prompt")
    })
    const waitUntil = vi.fn((promise: Promise<unknown>) => { waits.push(promise) })
    const running = schedule.run({ to, waitUntil, appAuth })
    await Promise.resolve()
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ dispatch: expect.any(Function) }))
    expect(to).not.toHaveBeenCalled()
    expect(waitUntil).toHaveBeenCalledTimes(1)
    expect(waits[0]).toBeDefined()
    resolve()
    await running
    await expect(waits[0]).resolves.toMatchObject({ id: "session-1" })
    expect(to).toHaveBeenCalledWith(channel, expect.objectContaining({
      channelId: AUTOMATION_CHANNEL_ID,
      installationTeamId: AUTOMATION_WORKSPACE_ID,
      initialMessage: expect.objectContaining({ fallbackText: expect.stringContaining("Account Signals — running") }),
    }))
    expect(send).toHaveBeenCalledWith("diagnostic prompt", { auth: owner.auth })
  })

  it("does not use a supplied appAuth", async () => {
    const toMock = vi.fn(() => ({ send: vi.fn(async () => session) }))
    const to = toMock as ScheduleArgs["to"]
    runner.mockImplementation(async (options: { dispatch: (actualOwner: typeof owner, prompt: string) => Promise<unknown> }) => options.dispatch(owner, "prompt"))
    await schedule.run({ to, waitUntil: vi.fn(), appAuth })
    expect(toMock).toHaveBeenCalledWith(channel, expect.objectContaining({ channelId: AUTOMATION_CHANNEL_ID, installationTeamId: AUTOMATION_WORKSPACE_ID }))
    expect(toMock.mock.calls.flat()).not.toContainEqual(expect.objectContaining({ authenticator: "app" }))
  })

  it("awaits and propagates a runner failure while registering the same rejection", async () => {
    reset()
    const error = new Error("runner failure")
    runner.mockRejectedValue(error)
    const waitUntil = vi.fn((promise: Promise<unknown>) => { waits.push(promise) })
    await expect(schedule.run({ to: vi.fn() as ScheduleArgs["to"], waitUntil, appAuth })).rejects.toBe(error)
    await expect(waits[0]).rejects.toBe(error)
  })
})
