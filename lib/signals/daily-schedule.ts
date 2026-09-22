export const DAILY_SCHEDULE_TIME_ZONE = "Europe/Berlin"
export const DAILY_SCHEDULE_HOUR = 8

const DAY = 86_400_000
const berlinClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: DAILY_SCHEDULE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
})

function clockParts(value: Date): Record<string, string> {
  return Object.fromEntries(
    berlinClock.formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  )
}

function calendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
}

function shiftCalendarDate(value: string, days: number): string {
  return new Date(Date.parse(`${value}T12:00:00.000Z`) + days * DAY).toISOString().slice(0, 10)
}

function berlinScheduleBoundary(value: string): Date {
  const [year, month, day] = value.split("-").map(Number)
  const targetWallTime = Date.UTC(year, month - 1, day, DAILY_SCHEDULE_HOUR)
  let candidate = targetWallTime
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = clockParts(new Date(candidate))
    const representedWallTime = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    )
    const correction = targetWallTime - representedWallTime
    candidate += correction
    if (correction === 0) break
  }
  return new Date(candidate)
}

/** Returns the Berlin calendar date once that date's 08:00 run is due. */
export function dueDailyScheduleDate(now: Date): string | null {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Invalid daily schedule clock")
  }

  const parts = clockParts(now)
  const hour = Number(parts.hour)
  if (!Number.isSafeInteger(hour) || hour < DAILY_SCHEDULE_HOUR) return null
  return `${parts.year}-${parts.month}-${parts.day}`
}

/** Returns adjacent 08:00 Berlin boundaries for one local calendar day. */
export function dailyScheduleWindow(dailyDate: string): { start: Date; end: Date } {
  if (!calendarDate(dailyDate)) throw new Error("Invalid daily schedule date")
  return {
    start: berlinScheduleBoundary(shiftCalendarDate(dailyDate, -1)),
    end: berlinScheduleBoundary(dailyDate),
  }
}

/** Returns the previous complete UTC day for a date-grained signal source. */
export function dailySignalWindow(dailyDate: string): { start: Date; end: Date } {
  if (!calendarDate(dailyDate)) throw new Error("Invalid daily signal date")
  return {
    start: new Date(`${shiftCalendarDate(dailyDate, -1)}T00:00:00.000Z`),
    end: new Date(`${dailyDate}T00:00:00.000Z`),
  }
}
