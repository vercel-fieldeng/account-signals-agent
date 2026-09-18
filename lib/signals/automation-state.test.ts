import { describe, expect, it } from "vitest"
import type { SessionAuthContext } from "eve/context"
import {
  AUTOMATION_CHANNEL_ID,
  AUTOMATION_OPERATOR_USER_ID,
  AUTOMATION_WORKSPACE_ID,
  automationOwnerFromAuth,
  slackTimestampToIso,
} from "./automation-policy"
import { AUTOMATION_STATE_PATH, AutomationStateStore } from "./automation-state"

const auth: SessionAuthContext = {
  authenticator: "slack-webhook",
  principalType: "user",
  principalId: `slack:${AUTOMATION_WORKSPACE_ID}:${AUTOMATION_OPERATOR_USER_ID}`,
  issuer: `slack:${AUTOMATION_WORKSPACE_ID}`,
  attributes: {
    user_id: AUTOMATION_OPERATOR_USER_ID,
    team_id: AUTOMATION_WORKSPACE_ID,
    channel_id: AUTOMATION_CHANNEL_ID,
    author_type: "user",
  },
}
const owner = automationOwnerFromAuth(auth)
const baseTime = new Date("2026-09-14T10:00:00.000Z")

type Fixture = {
  body?: string
  etag: string
  gets: Record<string, unknown>[]
  puts: Record<string, unknown>[]
  failGet?: boolean
  failPut?: boolean
  omitEtag?: boolean
  reportedSize?: number
  raceReads?: boolean
}

function fixture(initial?: string): Fixture {
  return { body: initial, etag: "etag-0", gets: [], puts: [] }
}

function sdk(store: Fixture) {
  let raceReadCount = 0
  let releaseRace!: () => void
  const raceGate = new Promise<void>((resolve) => {
    releaseRace = resolve
  })

  return {
    get: async (path: string, options: unknown) => {
      expect(path).toBe(AUTOMATION_STATE_PATH)
      store.gets.push(options as Record<string, unknown>)
      if (store.failGet) throw new Error("private backend failure")
      if (store.raceReads && raceReadCount < 2) {
        raceReadCount += 1
        if (raceReadCount === 2) releaseRace()
        await raceGate
      }
      if (!store.body) return null
      const bytes = new TextEncoder().encode(store.body)
      return {
        statusCode: 200 as const,
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes)
            controller.close()
          },
        }),
        headers: new Headers(),
        blob: {
          url: "https://private.invalid",
          downloadUrl: "https://private.invalid",
          pathname: path,
          contentDisposition: "inline",
          cacheControl: "no-store",
          uploadedAt: baseTime,
          etag: store.omitEtag ? "" : store.etag,
          contentType: "application/json",
          size: store.reportedSize ?? bytes.byteLength,
        },
      } as never
    },
    put: async (path: string, body: unknown, options: unknown) => {
      expect(path).toBe(AUTOMATION_STATE_PATH)
      const putOptions = options as Record<string, unknown>
      store.puts.push(putOptions)
      if (store.failPut) throw new Error("private backend failure")
      if (putOptions.ifMatch !== undefined && putOptions.ifMatch !== store.etag) {
        const error = new Error("conflict")
        error.name = "BlobPreconditionFailedError"
        throw error
      }
      if (putOptions.ifMatch === undefined && store.body) {
        const error = new Error("exists")
        error.name = "BlobPathnameMismatchError"
        throw error
      }
      store.body = String(body)
      store.etag = `etag-${store.puts.length}`
      return {} as never
    },
  }
}

function store(fixtureState = fixture(), now = baseTime) {
  return new AutomationStateStore({
    sdk: sdk(fixtureState),
    storeId: "test-store",
    now: () => new Date(now),
  })
}

function at(minutes = 0): string {
  return new Date(baseTime.getTime() + minutes * 60_000).toISOString()
}

function slackAt(microseconds: string): string {
  return slackTimestampToIso(`${Math.floor(baseTime.getTime() / 1000)}.${microseconds}`)
}

async function ready(stateStore: AutomationStateStore, requestId = "request-1") {
  const registration = await stateStore.beginSetup(owner, requestId, at())
  const job = await stateStore.completeSetup(registration.ticket)
  return { registration, job }
}

describe("AutomationStateStore", () => {
  it("keeps setup and completion idempotent with a stable due time", async () => {
    const state = fixture()
    const stateStore = store(state)
    const first = await stateStore.beginSetup(owner, "request-1", at())
    const replay = await stateStore.beginSetup(owner, "request-1", at())
    expect(replay).toEqual(first)

    const job = await stateStore.completeSetup(first.ticket)
    expect(await stateStore.completeSetup(first.ticket)).toEqual(job)
    expect((await stateStore.beginSetup(owner, "request-1", at())).scheduledFor).toBe(job.dueAt)
    expect(state.gets.every((entry) => entry.access === "private" && entry.useCache === false && entry.storeId === "test-store")).toBe(true)
    expect(state.puts.every((entry) => entry.access === "private" && entry.addRandomSuffix === false && entry.storeId === "test-store")).toBe(true)
  })

  it("orders setup and pause intents at Slack microsecond precision", async () => {
    const stateStore = store()
    const setupAt = slackAt("000100")
    const pauseAt = slackAt("000900")
    const registration = await stateStore.beginSetup(owner, "micro-request", setupAt)
    expect(await stateStore.beginSetup(owner, "micro-request", setupAt)).toEqual(registration)
    await stateStore.pause(owner, pauseAt)
    await expect(stateStore.completeSetup(registration.ticket)).rejects.toThrow("stale")
    await expect(stateStore.beginSetup(owner, "older-request", setupAt)).rejects.toThrow("stale")
  })

  it("writes a valid pause tombstone and permits only a newer setup", async () => {
    const state = fixture()
    const stateStore = store(state)
    const paused = await stateStore.pause(owner, at())
    expect(paused.setup.requestId).not.toBe("")
    expect((await stateStore.read())?.paused).toBe(true)

    await expect(stateStore.beginSetup(owner, "old-request", at())).rejects.toThrow("stale")
    const newer = await stateStore.beginSetup(owner, "new-request", at(1))
    expect((await stateStore.completeSetup(newer.ticket)).status).toBe("scheduled")
  })

  it("rejects stale and future setup intents, including cancelled tickets", async () => {
    const stateStore = store()
    const first = await stateStore.beginSetup(owner, "request-1", at())
    await stateStore.pause(owner, at(0.5))
    const second = await stateStore.beginSetup(owner, "request-2", at(0.75))

    await expect(stateStore.completeSetup(first.ticket)).rejects.toThrow("stale")
    await expect(stateStore.beginSetup(owner, "request-3", at(-1))).rejects.toThrow("stale")
    await expect(stateStore.beginSetup(owner, "request-4", new Date(baseTime.getTime() + 61_000).toISOString())).rejects.toThrow("Invalid")
    expect((await stateStore.completeSetup(second.ticket)).status).toBe("scheduled")
  })

  it("allows only one actual concurrent claim", async () => {
    const state = fixture()
    const setupStore = store(state)
    await ready(setupStore)
    const due = new Date(baseTime.getTime() + 6 * 60_000)
    const raceState = fixture(state.body)
    raceState.etag = state.etag
    raceState.raceReads = true
    const sharedSdk = sdk(raceState)
    const firstStore = new AutomationStateStore({ sdk: sharedSdk, storeId: "test-store", now: () => new Date(due) })
    const secondStore = new AutomationStateStore({ sdk: sharedSdk, storeId: "test-store", now: () => new Date(due) })
    const [first, second] = await Promise.all([firstStore.claimDue(), secondStore.claimDue()])
    expect([first, second].filter(Boolean)).toHaveLength(1)
    expect([first, second].filter((claim) => claim?.job.status === "checking")).toHaveLength(1)
  })

  it("blocks schedules more than fifteen minutes late", async () => {
    const state = fixture()
    await ready(store(state))
    const lateStore = store(state, new Date(baseTime.getTime() + 21 * 60_000))
    expect(await lateStore.claimDue()).toBeNull()
    expect((await lateStore.read())?.job).toMatchObject({ status: "blocked", failureCode: "schedule_expired" })
  })

  it("does not authorize a checking job after pause", async () => {
    const state = fixture()
    await ready(store(state))
    const dueStore = store(state, new Date(baseTime.getTime() + 6 * 60_000))
    const claim = await dueStore.claimDue()
    expect(claim).not.toBeNull()
    await dueStore.pause(owner, at(7))
    expect(await dueStore.authorizeDispatch(claim!)).toBe(false)
    expect((await dueStore.read())?.job?.status).toBe("cancelled")
  })

  it("preserves an accepted session when paused after dispatch authorization", async () => {
    const state = fixture()
    await ready(store(state))
    const dueStore = store(state, new Date(baseTime.getTime() + 6 * 60_000))
    const claim = await dueStore.claimDue()
    expect(await dueStore.authorizeDispatch(claim!)).toBe(true)
    await dueStore.pause(owner, at(7))
    await dueStore.markDispatched(claim!, "session-safe")
    expect((await dueStore.read())?.job).toMatchObject({ status: "dispatched", acceptedSessionId: "session-safe" })
    expect((await dueStore.read())?.paused).toBe(true)
  })

  it("reconciles an accepted session idempotently and keeps it active during setup", async () => {
    const state = fixture()
    const stateStore = store(state)
    await ready(stateStore)
    const dueStore = store(state, new Date(baseTime.getTime() + 6 * 60_000))
    const claim = await dueStore.claimDue()
    expect(await dueStore.authorizeDispatch(claim!)).toBe(true)
    await dueStore.markDispatched(claim!, "session-terminal")
    await expect(stateStore.beginSetup(owner, "replacement", at(1))).rejects.toThrow("busy")
    expect(await dueStore.reconcileSession("wrong-session", "completed")).toBe(false)
    expect(await dueStore.reconcileSession("session-terminal", "completed")).toBe(true)
    expect(await dueStore.reconcileSession("session-terminal", "completed")).toBe(true)
    expect((await dueStore.read())?.job).toMatchObject({ status: "completed", acceptedSessionId: "session-terminal" })
    expect((await dueStore.read())?.job?.terminalAt).toBeTypeOf("string")
  })

  it("marks an old dispatched session stale without touching a recent dispatch", async () => {
    const state = fixture()
    await ready(store(state))
    const dueStore = store(state, new Date(baseTime.getTime() + 6 * 60_000))
    const claim = await dueStore.claimDue()
    await dueStore.authorizeDispatch(claim!)
    await dueStore.markDispatched(claim!, "session-stale")

    const recent = await store(state, new Date(baseTime.getTime() + 6 * 60_000)).reconcileStaleDispatch(owner)
    expect(recent.reconciled).toBe(false)
    expect((await store(state).read())?.job?.status).toBe("dispatched")

    const recovered = await store(state, new Date(baseTime.getTime() + 30 * 60_000)).reconcileStaleDispatch(owner)
    expect(recovered.reconciled).toBe(true)
    expect(recovered.state?.job).toMatchObject({ status: "failed", failureCode: "session_stale", acceptedSessionId: "session-stale" })
  })

  it("arms an immediate trigger after a terminal job and enforces active/cooldown guards", async () => {
    const state = fixture()
    await ready(store(state))
    await expect(store(state).armImmediate("web-active")).rejects.toThrow("busy")

    const dueStore = store(state, new Date(baseTime.getTime() + 6 * 60_000))
    const claim = await dueStore.claimDue()
    await dueStore.authorizeDispatch(claim!)
    await dueStore.markDispatched(claim!, "session-trigger")
    await dueStore.reconcileSession("session-trigger", "completed")

    await expect(store(state, new Date(baseTime.getTime() + 6.5 * 60_000)).armImmediate("web-cooldown"))
      .rejects.toThrow("cooldown")
    const armed = await store(state, new Date(baseTime.getTime() + 7 * 60_000)).armImmediate("web-ready")
    expect(armed).toMatchObject({ status: "scheduled", dueAt: at(7) })
  })

  it("allows only one actual concurrent daily arm", async () => {
    const state = fixture()
    await ready(store(state))
    const setupRun = store(state, new Date(baseTime.getTime() + 6 * 60_000))
    const setupClaim = await setupRun.claimDue()
    await setupRun.authorizeDispatch(setupClaim!)
    await setupRun.markDispatched(setupClaim!, "session-before-daily-race")
    await setupRun.reconcileSession("session-before-daily-race", "completed")

    const raceState = fixture(state.body)
    raceState.etag = state.etag
    raceState.raceReads = true
    const sharedSdk = sdk(raceState)
    const now = new Date(baseTime.getTime() + 7 * 60_000)
    const firstStore = new AutomationStateStore({ sdk: sharedSdk, storeId: "test-store", now: () => new Date(now) })
    const secondStore = new AutomationStateStore({ sdk: sharedSdk, storeId: "test-store", now: () => new Date(now) })
    const armed = await Promise.all([firstStore.armDaily("2026-09-14"), secondStore.armDaily("2026-09-14")])

    expect(armed.filter(Boolean)).toHaveLength(1)
    expect(await firstStore.read()).toMatchObject({ schemaVersion: 2, lastDailyDate: "2026-09-14", job: { id: "daily:2026-09-14", status: "scheduled" } })
  })

  it("arms each daily date once and preserves its marker across manual runs", async () => {
    const state = fixture()
    await ready(store(state))
    expect(await store(state).armDaily("2026-09-14")).toBeNull()

    const setupRun = store(state, new Date(baseTime.getTime() + 6 * 60_000))
    const setupClaim = await setupRun.claimDue()
    await setupRun.authorizeDispatch(setupClaim!)
    await setupRun.markDispatched(setupClaim!, "session-setup")
    await setupRun.reconcileSession("session-setup", "completed")

    const dailyRun = store(state, new Date(baseTime.getTime() + 7 * 60_000))
    expect(await dailyRun.armDaily("2026-09-14")).toMatchObject({ status: "scheduled", dueAt: at(7) })
    expect(await dailyRun.read()).toMatchObject({ schemaVersion: 2, lastDailyDate: "2026-09-14" })
    expect(await dailyRun.armDaily("2026-09-14")).toBeNull()

    const dailyClaim = await dailyRun.claimDue()
    await dailyRun.authorizeDispatch(dailyClaim!)
    await dailyRun.markDispatched(dailyClaim!, "session-daily")
    await dailyRun.reconcileSession("session-daily", "completed")

    const manualRun = store(state, new Date(baseTime.getTime() + 8 * 60_000))
    await manualRun.armImmediate("manual-after-daily")
    const manualClaim = await manualRun.claimDue()
    await manualRun.authorizeDispatch(manualClaim!)
    await manualRun.markDispatched(manualClaim!, "session-manual")
    await manualRun.reconcileSession("session-manual", "completed")

    expect(await store(state, new Date(baseTime.getTime() + 9 * 60_000)).armDaily("2026-09-14")).toBeNull()
    await expect(store(state, new Date("2026-09-15T08:00:00.000Z")).armDaily("2026-09-15"))
      .resolves.toMatchObject({ status: "scheduled", dueAt: "2026-09-15T08:00:00.000Z" })
  })

  it("does not repeat an authorization-blocked run without a new setup", async () => {
    const state = fixture()
    await ready(store(state))
    const dueStore = store(state, new Date(baseTime.getTime() + 6 * 60_000))
    const claim = await dueStore.claimDue()
    await dueStore.block(claim!, "d0_authorization_required")

    expect(await store(state, new Date("2026-09-15T08:00:00.000Z")).armDaily("2026-09-15")).toBeNull()
    expect((await store(state).read())?.lastDailyDate).toBeUndefined()
  })

  it("records a terminal failure without accepting an arbitrary failure code", async () => {
    const state = fixture()
    await ready(store(state))
    const dueStore = store(state, new Date(baseTime.getTime() + 6 * 60_000))
    const claim = await dueStore.claimDue()
    await dueStore.authorizeDispatch(claim!)
    await dueStore.markDispatched(claim!, "session-failed")
    await expect(dueStore.reconcileSession("session-failed", "failed", "bad code")).rejects.toThrow("Invalid automation failure code")
    expect(await dueStore.reconcileSession("session-failed", "failed", "session_failed")).toBe(true)
    expect((await dueStore.read())?.job).toMatchObject({ status: "failed", failureCode: "session_failed" })
  })

  it("rejects noncanonical calendar rollover in setup intent and stored state", async () => {
    for (const invalid of ["2026-02-30T10:00:00.000000Z", "2026-09-14T24:00:00.000Z"]) {
      const state = fixture()
      const current = store(state)
      await expect(current.beginSetup(owner, "invalid-request", invalid)).rejects.toThrow("Invalid automation setup request")
      await ready(current)
      const persisted = JSON.parse(state.body!)
      persisted.lastIntentAt = invalid
      state.body = JSON.stringify(persisted)
      await expect(current.read()).rejects.toThrow("Automation state is unavailable")
    }
  })

  it("rejects invalid daily calendar dates in requests and persisted state", async () => {
    const state = fixture()
    const current = store(state)
    await ready(current)
    await expect(current.armDaily("2026-02-30")).rejects.toThrow("Invalid daily automation date")

    const persisted = JSON.parse(state.body!)
    persisted.schemaVersion = 2
    persisted.lastDailyDate = "2026-09-31"
    state.body = JSON.stringify(persisted)
    await expect(current.read()).rejects.toThrow("Automation state is unavailable")
  })

  it("fails closed for invalid metadata, missing ETags, oversized state, and failed writes", async () => {
    const malformed = fixture(JSON.stringify({ secret: "token-never-returned" }))
    await expect(store(malformed).read()).rejects.toThrow("Automation state is unavailable")
    await expect(store(malformed).read()).rejects.not.toThrow("token-never-returned")

    const missingEtag = fixture()
    await ready(store(missingEtag))
    missingEtag.omitEtag = true
    await expect(store(missingEtag).read()).rejects.toThrow("Automation state is unavailable")

    const oversized = fixture(JSON.stringify({ schemaVersion: 1 }))
    oversized.reportedSize = 64 * 1024 + 1
    await expect(store(oversized).read()).rejects.toThrow("Automation state is unavailable")

    const invalidJob = fixture(JSON.stringify({
      schemaVersion: 1,
      owner,
      paused: false,
      generation: 1,
      updatedAt: at(),
      lastIntentAt: at(),
      setup: { requestId: "request-1", requestedAt: at(), status: "ready" },
      job: { id: "job", dueAt: at(), status: "checking" },
    }))
    await expect(store(invalidJob).read()).rejects.toThrow("Automation state is unavailable")

    const ownerWithCredential = fixture(JSON.stringify({
      schemaVersion: 1,
      owner: { ...owner, token: "must-not-survive" },
      paused: true,
      generation: 1,
      updatedAt: at(),
      lastIntentAt: at(),
      setup: { requestId: "__paused__", requestedAt: at(), status: "cancelled" },
      job: null,
    }))
    await expect(store(ownerWithCredential).read()).rejects.toThrow("Automation state is unavailable")

    const failedWrite = fixture()
    failedWrite.failPut = true
    await expect(store(failedWrite).beginSetup(owner, "request-1", at())).rejects.toThrow("Unable to persist automation state")
    expect(failedWrite.body).toBeUndefined()
  })
})
