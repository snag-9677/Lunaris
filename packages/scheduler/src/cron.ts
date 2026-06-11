/**
 * Dependency-free 5-field cron parser/matcher.
 *
 * Fields (space-separated): minute hour day-of-month month day-of-week
 *   minute       0-59
 *   hour         0-23
 *   day-of-month 1-31
 *   month        1-12
 *   day-of-week  0-6  (0 = Sunday; 7 is accepted and normalized to 0)
 *
 * Each field supports:
 *   *            every value
 *   a            a single value
 *   a,b,c        a list
 *   a-b          an inclusive range
 *   * /n         a step over the whole range (start at field min)
 *   a-b/n        a step over a range
 *   a/n          a step from a to the field max
 *
 * Semantics match the common Vixie-cron convention: when BOTH day-of-month and
 * day-of-week are restricted (neither is '*'), a date matches if EITHER field
 * matches (union). Otherwise both must match (intersection with the always-true
 * '*' field).
 *
 * All matching is done in local time (the same zone as the Date passed in),
 * consistent with the rest of the harness using local Date construction.
 */

const FIELD_BOUNDS = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day-of-week
] as const;

export interface ParsedCron {
  /** Allowed values per field, as sorted unique arrays. */
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
  /** True when the day-of-month field was a literal '*' (restriction off). */
  domStar: boolean;
  /** True when the day-of-week field was a literal '*' (restriction off). */
  dowStar: boolean;
}

/** Search horizon guard: ~5 years of minutes, to avoid infinite scans. */
const MAX_MINUTE_STEPS = 5 * 366 * 24 * 60;

function parseField(raw: string, idx: number): { values: number[]; isStar: boolean } {
  const { min, max } = FIELD_BOUNDS[idx]!;
  const isStar = raw === '*';
  const out = new Set<number>();

  for (const part of raw.split(',')) {
    if (part.length === 0) {
      throw new Error(`cron: empty term in field ${idx}: "${raw}"`);
    }

    // Split off an optional step: "<range>/<step>".
    const [rangePart, stepPart, ...rest] = part.split('/');
    if (rest.length > 0 || rangePart === undefined) {
      throw new Error(`cron: malformed term "${part}" in field ${idx}`);
    }

    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`cron: invalid step "${stepPart}" in field ${idx}`);
      }
    }

    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b, ...extra] = rangePart.split('-');
      if (extra.length > 0 || a === undefined || b === undefined) {
        throw new Error(`cron: malformed range "${rangePart}" in field ${idx}`);
      }
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangePart);
      // A bare "a/n" steps from a up to the field max.
      hi = stepPart !== undefined ? max : lo;
    }

    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new Error(`cron: non-integer value in "${part}" of field ${idx}`);
    }
    if (lo > hi) {
      throw new Error(`cron: inverted range "${rangePart}" in field ${idx}`);
    }

    for (let v = lo; v <= hi; v += step) {
      let nv = v;
      // Normalize Sunday: cron allows 7 for the dow field; fold to 0.
      if (idx === 4 && nv === 7) nv = 0;
      if (nv < min || nv > max) {
        throw new Error(`cron: value ${v} out of range [${min},${max}] in field ${idx}`);
      }
      out.add(nv);
    }
  }

  return { values: [...out].sort((a, b) => a - b), isStar };
}

/** Parse a 5-field cron expression into per-field allowed-value sets. */
export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron: expected 5 fields, got ${fields.length} in "${expr}"`);
  }
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const fMinute = parseField(minute, 0);
  const fHour = parseField(hour, 1);
  const fDom = parseField(dom, 2);
  const fMonth = parseField(month, 3);
  const fDow = parseField(dow, 4);
  return {
    minute: fMinute.values,
    hour: fHour.values,
    dom: fDom.values,
    month: fMonth.values,
    dow: fDow.values,
    domStar: fDom.isStar,
    dowStar: fDow.isStar,
  };
}

function matchesParsed(p: ParsedCron, date: Date): boolean {
  if (!p.minute.includes(date.getMinutes())) return false;
  if (!p.hour.includes(date.getHours())) return false;
  if (!p.month.includes(date.getMonth() + 1)) return false;

  const domOk = p.dom.includes(date.getDate());
  const dowOk = p.dow.includes(date.getDay());

  // Vixie semantics: if both day fields are restricted, OR them; else AND.
  if (!p.domStar && !p.dowStar) {
    return domOk || dowOk;
  }
  return domOk && dowOk;
}

/** True if `date` (at minute resolution) satisfies the cron expression. */
export function matches(expr: string, date: Date): boolean {
  return matchesParsed(parseCron(expr), date);
}

/**
 * The first time strictly after `after` that matches the expression.
 *
 * Scans forward minute-by-minute from the start of the next minute. Seconds and
 * milliseconds of `after` are ignored (the next candidate is the following whole
 * minute). Throws if no match is found within ~5 years (a misconfigured/
 * impossible expression rather than a real schedule).
 */
export function nextRun(expr: string, after: Date): Date {
  const p = parseCron(expr);

  // Start at the next whole minute after `after`.
  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  for (let i = 0; i < MAX_MINUTE_STEPS; i++) {
    // Fast-forward by whole months when the month doesn't match.
    if (!p.month.includes(cursor.getMonth() + 1)) {
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (matchesParsed(p, cursor)) {
      return new Date(cursor.getTime());
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  throw new Error(
    `cron: no match for "${expr}" within ~5 years of ${after.toISOString()}; ` +
      'the expression is likely impossible',
  );
}
