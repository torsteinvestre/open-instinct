// [sunshine:watcher]
import { describe, expect, it } from "vitest";
import { ago, checkCron, inQuietHours, localDate, normalizeTime } from "../src/clock.js";

describe("clock", () => {
  it("reads times of day the way people write them", () => {
    expect(normalizeTime("9")).toBe("09:00");
    expect(normalizeTime(" 9:30 ")).toBe("09:30");
    expect(normalizeTime("21.05")).toBe("21:05");
    for (const bad of ["24:00", "9:60", "abc", "", "9pm"]) expect(normalizeTime(bad), bad).toBeUndefined();
  });

  it("knows quiet hours in the owner's timezone, across midnight", () => {
    const q = { start: "22:00", end: "08:00" };
    expect(inQuietHours(new Date("2026-10-13T21:30:00Z"), "Europe/Oslo", q)).toBe(true); // 23:30 Oslo
    expect(inQuietHours(new Date("2026-10-13T05:30:00Z"), "Europe/Oslo", q)).toBe(true); // 07:30 Oslo
    expect(inQuietHours(new Date("2026-10-13T06:00:00Z"), "Europe/Oslo", q)).toBe(false); // 08:00 Oslo
    expect(inQuietHours(new Date("2026-10-13T10:00:00Z"), "Europe/Oslo", q)).toBe(false); // 12:00 Oslo
  });

  it("treats equal start and end as no quiet hours, and a daytime window as daytime", () => {
    expect(inQuietHours(new Date("2026-10-13T21:30:00Z"), "Europe/Oslo", { start: "00:00", end: "00:00" })).toBe(false);
    expect(inQuietHours(new Date("2026-10-13T12:00:00Z"), "Europe/Oslo", { start: "13:00", end: "15:00" })).toBe(true); // 14:00 Oslo
    expect(inQuietHours(new Date("2026-10-13T14:00:00Z"), "Europe/Oslo", { start: "13:00", end: "15:00" })).toBe(false); // 16:00 Oslo
  });

  it("counts days in the owner's timezone", () => {
    expect(localDate(new Date("2026-10-13T22:30:00Z"), "Europe/Oslo")).toBe("2026-10-14");
    expect(localDate(new Date("2026-10-13T22:30:00Z"), "UTC")).toBe("2026-10-13");
  });

  it("schedules checks only outside quiet hours", () => {
    const q = { start: "22:00", end: "08:00" };
    expect(checkCron(60, q)).toBe("0 8,9,10,11,12,13,14,15,16,17,18,19,20,21 * * *");
    expect(checkCron(30, q)).toBe("0,30 8,9,10,11,12,13,14,15,16,17,18,19,20,21 * * *");
    expect(checkCron(120, q)).toBe("0 8,10,12,14,16,18,20 * * *");
    // Quiet until 07:30: the 07:00 check would be inside it, so the first is 08:00.
    expect(checkCron(60, { start: "23:00", end: "07:30" })).toBe("0 8,9,10,11,12,13,14,15,16,17,18,19,20,21,22 * * *");
    expect(checkCron(60, { start: "00:00", end: "00:00" })!.split(" ")[1]!.split(",")).toHaveLength(24);
  });

  // [sunshine:watcher] Long gaps start at the first full hour after quiet hours. Before, with quiet
  // until 07:30 the 07:00 check fell inside them: a daily check then had no hour and ran every hour.
  it("starts long gaps at the first full hour after quiet hours, and never falls back to every hour", () => {
    const q = { start: "23:00", end: "07:30" };
    expect(checkCron(1440, q)).toBe("0 8 * * *");
    expect(checkCron(720, q)).toBe("0 8,20 * * *");
    expect(checkCron(120, q)).toBe("0 8,10,12,14,16,18,20,22 * * *");
    expect(checkCron(1440, { start: "23:00", end: "07:00" })).toBe("0 7 * * *");
    expect(checkCron(120, { start: "08:00", end: "07:59" })).toBeUndefined(); // quiet all day but a minute
  });

  it("says how long ago in plain words", () => {
    const now = new Date("2026-10-13T10:00:00Z");
    expect(ago("2026-10-13T09:15:00Z", now)).toBe("45 min ago");
    expect(ago("2026-10-13T07:00:00Z", now)).toBe("3 h ago");
    expect(ago("2026-10-10T10:00:00Z", now)).toBe("3 days ago");
    expect(ago(undefined, now)).toBe("time unknown");
  });
});
