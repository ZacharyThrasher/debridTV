// Wall-clock rules for a channel: restricted hours and weekday time slots.
//
// The station clock works in UTC milliseconds, but "Saturday 08:00" and "after
// 22:00" are local, so this module turns the rules into a sequence of windows on
// the UTC timeline, each carrying what may air in it. Local times are resolved in
// a named IANA time zone (not the process's), so the result is the same on every
// machine and DST changes are handled where they happen (gate C5):
//
//   spring forward  a rule time that doesn't exist that night (02:30) starts at
//                   the first instant after the gap
//   fall back       a rule time that happens twice starts at the first one
//
// Adjacent windows with the same contents are merged, so a rule that repeats
// every day, or that runs past midnight, is one window, not two.

import type { Rating } from "./ratings.ts";
import { stricter } from "./ratings.ts";
import type { Ordering } from "./types.ts";

export interface DaypartProgram {
  /** Stable name for this source (e.g. the rule key it was copied from). */
  key: string;
  itemIds: string[];
  ordering: Ordering;
  slotMs?: number;
}

/** Yearly dates, "MM-DD", inclusive; `to` before `from` wraps the new year (12-15 to 01-05). */
export interface DateRange {
  from: string;
  to: string;
}

export interface DaypartRule {
  /** ISO weekdays, Mon=1 … Sun=7. Missing = every day. Days count from the start time. */
  days?: number[];
  /** "HH:MM" local. */
  from: string;
  /** "HH:MM" local; at or before `from` means the window ends the next day. */
  to: string;
  /** While the window is open, nothing rated above this airs. */
  maxRating?: Rating;
  /** While the window is open, this replaces the channel's usual lineup. */
  program?: DaypartProgram;
  /** Only on these dates each year (seasonal slots, N-32); the date the window starts counts. */
  dates?: DateRange;
  /** Turns `dates` around: the rule applies on every date outside the range. */
  outside?: boolean;
  /** Nothing airs while this rule's window is open (a seasonal channel out of season). */
  offAir?: boolean;
}

export interface Dayparts {
  timeZone: string;
  rules: DaypartRule[];
}

/** One stretch of time with one set of airing rules. */
export interface Window {
  startMs: number;
  endMs: number;
  /** Index into rules of the slot program that fills it; -1 = the usual lineup. */
  program: number;
  maxRating?: Rating;
  /** Same key = same source of programs; windows with one key share a running order. */
  key: string;
  /** Off the air: nothing is scheduled. */
  off?: boolean;
}

interface LocalDate {
  y: number;
  m: number;
  d: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** True when the runtime knows this IANA zone name. */
export function validTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Local wall-clock fields of a UTC instant. */
export function localFields(ms: number, tz: string): { y: number; m: number; d: number; h: number; min: number; s: number } {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) if (p.type !== "literal") out[p.type] = Number(p.value);
  return { y: out.year!, m: out.month!, d: out.day!, h: out.hour! % 24, min: out.minute!, s: out.second! };
}

/** Offset of local time from UTC at this instant, in ms (whole seconds). */
function offsetAt(ms: number, tz: string): number {
  const f = localFields(ms, tz);
  const floored = Math.floor(ms / 1000) * 1000;
  return Date.UTC(f.y, f.m - 1, f.d, f.h, f.min, f.s) - floored;
}

/**
 * The UTC instant of a local date and time. Times in a spring-forward gap move to
 * the end of the gap; times that happen twice resolve to the earlier one.
 */
export function zonedMs(date: LocalDate, minutes: number, tz: string): number {
  const naive = Date.UTC(date.y, date.m - 1, date.d, 0, minutes);
  // Try both offsets seen around the naive instant; keep those that round-trip.
  const offs = [...new Set([offsetAt(naive - 86_400_000 / 2, tz), offsetAt(naive, tz), offsetAt(naive + 86_400_000 / 2, tz)])];
  const exact = offs.map((o) => naive - o).filter((ms) => naive - offsetAt(ms, tz) === ms).sort((a, b) => a - b);
  if (exact.length) return exact[0]!;
  // In a gap: the wall time never happens. Start where the gap ends.
  const before = naive - Math.max(...offs);
  const after = naive - Math.min(...offs);
  let lo = Math.min(before, after);
  let hi = Math.max(before, after);
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2000) * 1000;
    const f = localFields(mid, tz);
    if (Date.UTC(f.y, f.m - 1, f.d, f.h, f.min) < naive) lo = mid;
    else hi = mid;
  }
  return hi;
}

function addDays(d: LocalDate, n: number): LocalDate {
  const t = new Date(Date.UTC(d.y, d.m - 1, d.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** ISO weekday, Mon=1 … Sun=7. */
function weekday(d: LocalDate): number {
  return ((new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay() + 6) % 7) + 1;
}

const MMDD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** True for a well-formed "MM-DD". */
export function validMonthDay(s: unknown): s is string {
  return typeof s === "string" && MMDD.test(s);
}

/** Whether a local date falls in a yearly range (inclusive; wraps the new year when to < from). */
export function inDates(d: { m: number; d: number }, r: DateRange): boolean {
  const md = d.m * 100 + d.d;
  const a = Number(r.from.replace("-", ""));
  const b = Number(r.to.replace("-", ""));
  return a <= b ? md >= a && md <= b : md >= a || md <= b;
}

/**
 * A yearly season as of `nowMs` in a zone: in or out, and the local midnight
 * when that next changes (null if it never does, e.g. 01-01 to 12-31).
 */
export function seasonState(r: DateRange, nowMs: number, tz: string): { inSeason: boolean; nextChangeMs: number | null } {
  const f = localFields(nowMs, tz);
  let date: LocalDate = { y: f.y, m: f.m, d: f.d };
  const inSeason = inDates(date, r);
  for (let i = 0; i < 367; i++) {
    date = addDays(date, 1);
    if (inDates(date, r) !== inSeason) return { inSeason, nextChangeMs: zonedMs(date, 0, tz) };
  }
  return { inSeason, nextChangeMs: null };
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}

/** Each rule's open intervals that start on this local date. */
function intervalsStarting(rules: DaypartRule[], date: LocalDate, tz: string): Array<{ rule: number; startMs: number; endMs: number }> {
  const out: Array<{ rule: number; startMs: number; endMs: number }> = [];
  const wd = weekday(date);
  rules.forEach((r, i) => {
    if (r.days && r.days.length && !r.days.includes(wd)) return;
    if (r.dates && inDates(date, r.dates) === !!r.outside) return;
    const a = minutesOf(r.from);
    const b = minutesOf(r.to);
    const startMs = zonedMs(date, a, tz);
    const endMs = b > a ? zonedMs(date, b, tz) : zonedMs(addDays(date, 1), b, tz);
    if (endMs > startMs) out.push({ rule: i, startMs, endMs });
  });
  return out;
}

function windowKey(program: number, maxRating: Rating | undefined, off = false): string {
  return off ? "off" : `${program < 0 ? "base" : `slot${program}`}|${maxRating ?? "any"}`;
}

/**
 * Windows from the local day containing `fromMs` onward, merged. The first window
 * may start before `fromMs`. Earlier slot rules win where slots overlap; rating
 * limits always combine to the strictest one in force.
 */
export function* windows(dp: Dayparts, fromMs: number, baseMax?: Rating): Generator<Window> {
  const f = localFields(fromMs, dp.timeZone);
  let date: LocalDate = { y: f.y, m: f.m, d: f.d };
  let pending: Window | null = null;
  // A day with no rules at all would loop forever below; there is always one, but guard anyway.
  for (let guard = 0; guard < 100_000; guard++) {
    const dayStart = zonedMs(date, 0, dp.timeZone);
    const next = addDays(date, 1);
    const dayEnd = zonedMs(next, 0, dp.timeZone);
    // Intervals that started yesterday can still be open today.
    const open = [...intervalsStarting(dp.rules, addDays(date, -1), dp.timeZone), ...intervalsStarting(dp.rules, date, dp.timeZone)]
      .filter((iv) => iv.endMs > dayStart && iv.startMs < dayEnd);
    const cuts = new Set([dayStart, dayEnd]);
    for (const iv of open) {
      if (iv.startMs > dayStart) cuts.add(iv.startMs);
      if (iv.endMs < dayEnd) cuts.add(iv.endMs);
    }
    const sorted = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = sorted[i]!;
      const b = sorted[i + 1]!;
      const active = open.filter((iv) => iv.startMs <= a && iv.endMs > a).map((iv) => iv.rule).sort((x, y) => x - y);
      const program = active.find((r) => dp.rules[r]!.program) ?? -1;
      let maxRating = baseMax;
      for (const r of active) maxRating = stricter(maxRating, dp.rules[r]!.maxRating);
      const off = active.some((r) => dp.rules[r]!.offAir);
      const key = windowKey(program, maxRating, off);
      // Same contents carry on; a very long run is still handed out a week at a
      // time (the consumer joins touching windows with the same key).
      if (pending && pending.key === key && pending.endMs === a && b - pending.startMs <= 7 * 86_400_000) pending.endMs = b;
      else {
        if (pending) yield pending;
        pending = { startMs: a, endMs: b, program, maxRating, key, ...(off ? { off } : {}) };
      }
    }
    date = next;
  }
  if (pending) yield pending;
}
