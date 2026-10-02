'use strict';
// Calendar helpers. User-facing review dates are calendar days in America/New_York.

const TZ = 'America/New_York';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function ymdInTz(date = new Date(), tz = TZ) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function isYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function ymdToUtc(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(ymd, n) {
  const dt = ymdToUtc(ymd);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function dayOfWeek(ymd) {
  return ymdToUtc(ymd).getUTCDay(); // 0 = Sunday
}

function daysBetween(fromYmd, toYmd) {
  return Math.round((ymdToUtc(toYmd) - ymdToUtc(fromYmd)) / 86400000);
}

function longDate(ymd) {
  const dt = ymdToUtc(ymd);
  const wd = WEEKDAYS[dt.getUTCDay()];
  return `${wd[0].toUpperCase()}${wd.slice(1)}, ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`;
}

// Turns "2026-10-09", "today", "tomorrow", "friday", "this friday", "next friday",
// "in 2 weeks" into a calendar date. "next <weekday>" means the weekday in the
// following Monday-Sunday week; the other reading is returned as `alternative`
// so the caller can mention it.
function parseDue(input, today = ymdInTz()) {
  const raw = String(input || '').trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
  if (!raw) throw new Error('A due date is required (YYYY-MM-DD, "friday", "next friday", "in 2 weeks"...).');
  const iso = String(input).trim();
  if (isYmd(iso)) return { date: iso, interpretation: `${longDate(iso)} (America/New_York)`, alternative: null };
  if (raw === 'today') return { date: today, interpretation: `today, ${longDate(today)}`, alternative: null };
  if (raw === 'tomorrow') {
    const d = addDays(today, 1);
    return { date: d, interpretation: `tomorrow, ${longDate(d)}`, alternative: null };
  }
  let m = raw.match(/^in (\d{1,3}) (day|days|week|weeks|month|months)$/);
  if (m) {
    const n = Number(m[1]);
    let d;
    if (m[2].startsWith('day')) d = addDays(today, n);
    else if (m[2].startsWith('week')) d = addDays(today, 7 * n);
    else {
      const dt = ymdToUtc(today);
      dt.setUTCMonth(dt.getUTCMonth() + n);
      d = dt.toISOString().slice(0, 10);
    }
    return { date: d, interpretation: `${raw} → ${longDate(d)}`, alternative: null };
  }
  m = raw.match(/^(this |coming |next )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if (m) {
    const target = WEEKDAYS.indexOf(m[2]);
    const dow = dayOfWeek(today);
    let delta = (target - dow + 7) % 7;
    if (delta === 0) delta = 7;
    const nextOccurrence = addDays(today, delta);
    if (m[1] === 'next ') {
      const isoDow = dow === 0 ? 7 : dow; // Monday = 1 ... Sunday = 7
      const daysToSunday = 7 - isoDow;
      const chosen = delta <= daysToSunday ? addDays(nextOccurrence, 7) : nextOccurrence;
      return {
        date: chosen,
        interpretation: `next ${m[2]} → ${longDate(chosen)}`,
        alternative: chosen !== nextOccurrence ? nextOccurrence : null,
      };
    }
    return { date: nextOccurrence, interpretation: `${m[2]} → ${longDate(nextOccurrence)}`, alternative: null };
  }
  throw new Error(`Could not read "${input}" as a date. Use YYYY-MM-DD.`);
}

module.exports = { TZ, ymdInTz, isYmd, addDays, dayOfWeek, daysBetween, longDate, parseDue, ymdToUtc };
