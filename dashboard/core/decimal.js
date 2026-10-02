'use strict';
// Exact decimal arithmetic for quantities and money (audit F20).
// Values are BigInt fixed-point numbers with 18 decimal places. Parsing rejects
// input with more precision than that instead of silently rounding it away, and
// there is no float epsilon: a quantity is zero only when it is exactly zero.

const SCALE = 18;
const ONE = 10n ** BigInt(SCALE);
const DEC_RE = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

class DecimalError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID';
  }
}

// Parses a number or numeric string. Returns { value: BigInt, exact: true } or
// throws. With { round: true } extra digits are rounded half-even instead.
function parse(input, { round = false, label = 'value' } = {}) {
  if (typeof input === 'bigint') return { value: input * ONE, exact: true };
  let s;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new DecimalError(`${label} is not a finite number`);
    s = String(input);
  } else if (typeof input === 'string') {
    s = input.trim().replace(/[$,\s_]/g, '');
  } else {
    throw new DecimalError(`${label} must be a number`);
  }
  const m = DEC_RE.exec(s);
  if (!m || (!m[2] && !m[3])) throw new DecimalError(`${label} "${String(input).slice(0, 40)}" is not a number`);
  const sign = m[1] === '-' ? -1n : 1n;
  const intPart = m[2] || '0';
  const frac = m[3] || '';
  const exp = m[4] ? Number(m[4]) : 0;
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 60) throw new DecimalError(`${label} exponent out of range`);
  const digits = BigInt(`${intPart}${frac}` || '0');
  const shift = SCALE + exp - frac.length;
  let value;
  let exact = true;
  if (shift >= 0) {
    value = digits * 10n ** BigInt(shift);
  } else {
    const div = 10n ** BigInt(-shift);
    const q = digits / div;
    const r = digits % div;
    if (r !== 0n) {
      if (!round) throw new DecimalError(`${label} "${String(input).slice(0, 40)}" has more than ${SCALE} decimal places`);
      exact = false;
      value = roundHalfEven(q, r, div);
    } else value = q;
  }
  return { value: sign * value, exact };
}

function roundHalfEven(q, r, div) {
  const twice = r * 2n;
  if (twice > div || (twice === div && q % 2n === 1n)) return q + 1n;
  return q;
}

function of(input, opts) {
  if (input === null || input === undefined || input === '') return null;
  return parse(input, opts).value;
}

function add(a, b) {
  return a + b;
}

function sub(a, b) {
  return a - b;
}

function mul(a, b) {
  const p = a * b;
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const q = abs / ONE;
  const r = abs % ONE;
  const v = roundHalfEven(q, r, ONE);
  return neg ? -v : v;
}

function div(a, b) {
  if (b === 0n) throw new DecimalError('division by zero');
  const neg = (a < 0n) !== (b < 0n);
  const n = (a < 0n ? -a : a) * ONE;
  const d = b < 0n ? -b : b;
  const v = roundHalfEven(n / d, n % d, d);
  return neg ? -v : v;
}

function cmp(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

function min(a, b) {
  return a < b ? a : b;
}

function max(a, b) {
  return a > b ? a : b;
}

function isZero(a) {
  return a === 0n;
}

function decimalsOf(a) {
  const s = toString(a);
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}

function toString(a) {
  if (a === null || a === undefined) return null;
  const neg = a < 0n;
  const abs = neg ? -a : a;
  const int = abs / ONE;
  let frac = (abs % ONE).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

function toNumber(a) {
  if (a === null || a === undefined) return null;
  return Number(toString(a));
}

// Exact multiplication by a ratio n/d, distributing rounding so the parts sum
// exactly to the total (for splitting lots without losing units).
function splitProportionally(parts, newTotal) {
  const oldTotal = parts.reduce((s, p) => s + p, 0n);
  if (oldTotal === 0n) return parts.map(() => 0n);
  const out = parts.map((p) => (p * newTotal) / oldTotal);
  let rem = newTotal - out.reduce((s, p) => s + p, 0n);
  for (let i = out.length - 1; rem !== 0n && i >= 0; i--) {
    const step = rem > 0n ? 1n : -1n;
    out[i] += step;
    rem -= step;
  }
  return out;
}

module.exports = { SCALE, ONE, parse, of, add, sub, mul, div, cmp, min, max, isZero, toString, toNumber, decimalsOf, splitProportionally, DecimalError };
