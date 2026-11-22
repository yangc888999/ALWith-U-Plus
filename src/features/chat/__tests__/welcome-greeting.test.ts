import { describe, expect, test } from "vitest"

import { greetingKey, greetingPeriod, welcomeName, welcomeSubtitleKey } from "../welcome-greeting"

describe("welcome greeting", () => {
  test.each([
    [4, "lateNight"],
    [5, "morning"],
    [11, "morning"],
    [12, "afternoon"],
    [17, "afternoon"],
    [18, "evening"],
    [21, "evening"],
    [22, "lateEvening"],
    [23, "lateEvening"]
  ])("hour %i is %s", (hour, period) => {
    expect(greetingPeriod(new Date(2026, 10, 22, hour, 0, 0))).toBe(period)
  })

  test("a nickname wins over the account email", () => {
    expect(welcomeName("Leo", "chen.yang@example.com")).toBe("Leo")
  })

  test("an account without a nickname uses the email local part", () => {
    expect(welcomeName("chen.yang@example.com", "chen.yang@example.com")).toBe("chen.yang")
    expect(welcomeName(null, "chen.yang@example.com")).toBe("chen.yang")
  })

  test("an anonymous reader gets the greeting without a name", () => {
    expect(greetingKey("morning", false)).toBe("welcome.morningAnon")
    expect(greetingKey("lateNight", true)).toBe("welcome.lateNight")
    expect(greetingKey("lateEvening", true)).toBe("welcome.lateEvening")
  })

  test("late evening and late night carry their own rest reminders", () => {
    expect(welcomeSubtitleKey("lateEvening")).toBe("welcome.lateEveningSubtitle")
    expect(welcomeSubtitleKey("lateNight")).toBe("welcome.lateNightSubtitle")
    expect(welcomeSubtitleKey("evening")).toBe("welcome.subtitle")
  })
})

