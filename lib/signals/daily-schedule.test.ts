import { describe, expect, it } from "vitest"
import { dailyScheduleWindow, dailySignalWindow, dueDailyScheduleDate } from "./daily-schedule"

describe("Berlin daily schedule", () => {
  it("becomes due at 08:00 Europe/Berlin in summer time", () => {
    expect(dueDailyScheduleDate(new Date("2026-07-01T05:59:59.999Z"))).toBeNull()
    expect(dueDailyScheduleDate(new Date("2026-07-01T06:00:00.000Z"))).toBe("2026-07-01")
    expect(dueDailyScheduleDate(new Date("2026-07-01T21:59:59.999Z"))).toBe("2026-07-01")
  })

  it("becomes due at 08:00 Europe/Berlin in winter time", () => {
    expect(dueDailyScheduleDate(new Date("2026-01-15T06:59:59.999Z"))).toBeNull()
    expect(dueDailyScheduleDate(new Date("2026-01-15T07:00:00.000Z"))).toBe("2026-01-15")
  })

  it("uses adjacent Berlin 08:00 boundaries across daylight-saving changes", () => {
    const spring = dailyScheduleWindow("2026-03-29")
    expect(spring.start.toISOString()).toBe("2026-03-28T07:00:00.000Z")
    expect(spring.end.toISOString()).toBe("2026-03-29T06:00:00.000Z")

    const autumn = dailyScheduleWindow("2026-10-25")
    expect(autumn.start.toISOString()).toBe("2026-10-24T06:00:00.000Z")
    expect(autumn.end.toISOString()).toBe("2026-10-25T07:00:00.000Z")
  })

  it("uses the previous complete UTC day for date-grained signals, including across DST", () => {
    expect(dailySignalWindow("2026-09-22")).toEqual({
      start: new Date("2026-09-21T00:00:00.000Z"),
      end: new Date("2026-09-22T00:00:00.000Z"),
    })
    expect(dailySignalWindow("2026-03-29")).toEqual({
      start: new Date("2026-03-28T00:00:00.000Z"),
      end: new Date("2026-03-29T00:00:00.000Z"),
    })
    expect(dailySignalWindow("2026-10-25")).toEqual({
      start: new Date("2026-10-24T00:00:00.000Z"),
      end: new Date("2026-10-25T00:00:00.000Z"),
    })
  })

  it("rejects invalid clocks and calendar dates", () => {
    expect(() => dueDailyScheduleDate(new Date("invalid"))).toThrow("Invalid daily schedule clock")
    expect(() => dailyScheduleWindow("2026-02-30")).toThrow("Invalid daily schedule date")
    expect(() => dailySignalWindow("2026-02-30")).toThrow("Invalid daily signal date")
  })
})
