import { ProjectHoliday, ProjectSettings } from '../models/types';

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MS_PER_DAY = 86_400_000;

export const MAX_SIM_DAYS = 730;
export const MIN_SIM_DAYS = 1;

export function isValidISODate(iso: string | undefined | null): iso is string {
  if (!iso || typeof iso !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso.trim())) return false;
  const [y, m, d] = iso.trim().split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function parseISODateUTC(iso: string): Date {
  if (!isValidISODate(iso)) {
    return new Date(Date.UTC(2026, 3, 1));
  }
  const [y, m, d] = iso.trim().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatISODateUTC(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDaysISO(iso: string, deltaDays: number): string {
  const dt = parseISODateUTC(iso);
  dt.setUTCDate(dt.getUTCDate() + Math.round(deltaDays));
  return formatISODateUTC(dt);
}

/**
 * Maps simulation day index (0 = Day 0 baseline, 1 = startDate, N = endDate)
 * to its deterministic UTC ISO calendar date string (YYYY-MM-DD).
 */
export function dayIndexToDateISO(startDateISO: string, day: number): string {
  if (day <= 1) return isValidISODate(startDateISO) ? startDateISO : '2026-04-01';
  return addDaysISO(startDateISO, day - 1);
}

/**
 * Computes inclusive calendar day count between startDate and endDate, clamped to [1, MAX_SIM_DAYS].
 */
export function computeInclusiveDays(startDateISO: string, endDateISO: string): number {
  const start = parseISODateUTC(startDateISO);
  const end = parseISODateUTC(endDateISO);
  const diff = Math.round((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;
  if (!Number.isFinite(diff) || diff < MIN_SIM_DAYS) return MIN_SIM_DAYS;
  return Math.min(MAX_SIM_DAYS, diff);
}

/**
 * Converts an ISO date into a clamped 1-based simulation day index relative to startDate.
 */
export function dateISOToDayIndex(startDateISO: string, dateISO: string, totalDays: number): number {
  const start = parseISODateUTC(startDateISO);
  const target = parseISODateUTC(dateISO);
  const idx = Math.round((target.getTime() - start.getTime()) / MS_PER_DAY) + 1;
  return Math.max(1, Math.min(Math.max(1, totalDays), idx));
}

export function getDayOfWeekUTC(iso: string): number {
  return parseISODateUTC(iso).getUTCDay();
}

export function getWeekdayShort(iso: string): string {
  return DAY_SHORT[getDayOfWeekUTC(iso)] || 'Mon';
}

export function formatShortDate(iso: string): string {
  const dt = parseISODateUTC(iso);
  return `${dt.getUTCDate()} ${MONTH_SHORT[dt.getUTCMonth()]}`;
}

export function formatCompactNumericDate(iso: string): string {
  const dt = parseISODateUTC(iso);
  return `${String(dt.getUTCDate()).padStart(2, '0')}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function formatFullDateWithWeekday(iso: string): string {
  const dt = parseISODateUTC(iso);
  const dow = DAY_SHORT[dt.getUTCDay()];
  const day = dt.getUTCDate();
  const mon = MONTH_SHORT[dt.getUTCMonth()];
  const yr = dt.getUTCFullYear();
  return `${dow} ${day} ${mon} ${yr}`;
}

export function findHolidayForDate(
  iso: string,
  holidays: ProjectHoliday[] | undefined
): ProjectHoliday | undefined {
  if (!holidays || holidays.length === 0) return undefined;
  for (const h of holidays) {
    if (!isValidISODate(h.startDate) || !isValidISODate(h.endDate)) continue;
    if (iso >= h.startDate && iso <= h.endDate) {
      return h;
    }
  }
  return undefined;
}

export function evaluateCalendarDay(
  projectSettings: ProjectSettings,
  day: number
): {
  dateISO: string;
  dayOfWeek: number;
  weekdayShort: string;
  isWorkweekDay: boolean;
  holiday?: ProjectHoliday;
  isWorkingDay: boolean;
  nonWorkingReason?: string;
} {
  const dateISO = dayIndexToDateISO(projectSettings.startDate, day);
  const dayOfWeek = getDayOfWeekUTC(dateISO);
  const weekdayShort = DAY_SHORT[dayOfWeek];
  if (day <= 0) {
    return {
      dateISO,
      dayOfWeek,
      weekdayShort,
      isWorkweekDay: true,
      isWorkingDay: true
    };
  }
  const workArr = projectSettings.workingDays;
  const isWorkweekDay = Array.isArray(workArr) && workArr.length === 7 ? Boolean(workArr[dayOfWeek]) : true;
  const holiday = findHolidayForDate(dateISO, projectSettings.holidays);
  const isWorkingDay = isWorkweekDay && !holiday;
  const nonWorkingReason = holiday
    ? `Holiday: ${holiday.name}`
    : !isWorkweekDay
    ? `Non-working day (${weekdayShort})`
    : undefined;
  return {
    dateISO,
    dayOfWeek,
    weekdayShort,
    isWorkweekDay,
    holiday,
    isWorkingDay,
    nonWorkingReason
  };
}

export function computeWorkingDayStats(projectSettings: ProjectSettings): {
  totalDays: number;
  workingDaysCount: number;
  nonWorkingDaysCount: number;
  holidayDaysCount: number;
} {
  const totalDays = computeInclusiveDays(projectSettings.startDate, projectSettings.endDate);
  let workingDaysCount = 0;
  let holidayDaysCount = 0;
  for (let d = 1; d <= totalDays; d++) {
    const info = evaluateCalendarDay(projectSettings, d);
    if (info.holiday) holidayDaysCount++;
    if (info.isWorkingDay) workingDaysCount++;
  }
  return {
    totalDays,
    workingDaysCount,
    nonWorkingDaysCount: Math.max(0, totalDays - workingDaysCount),
    holidayDaysCount
  };
}

/**
 * Returns clean adaptive tick day indices (0..totalDays) for SVG graph X-axis
 * so labels never crowd or overlap across 7d, 30d, 90d, 180d, or 365d+ horizons.
 */
export function getAdaptiveGraphTicks(totalDays: number): number[] {
  const ticks: number[] = [0];
  let step = 5;
  if (totalDays <= 14) step = 2;
  else if (totalDays <= 35) step = 5;
  else if (totalDays <= 70) step = 7;
  else if (totalDays <= 140) step = 14;
  else if (totalDays <= 240) step = 30;
  else step = 60;

  for (let d = step; d < totalDays; d += step) {
    if (totalDays - d >= Math.max(2, Math.floor(step * 0.45))) {
      ticks.push(d);
    }
  }
  if (totalDays > 0 && ticks[ticks.length - 1] !== totalDays) {
    ticks.push(totalDays);
  }
  return ticks;
}
