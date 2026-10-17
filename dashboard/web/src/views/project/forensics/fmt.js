// Small formatting helpers shared by the Forensics tab's parts.
import { fmtDate, fmtDateTime, fmtCompactUsd, fmtPrice } from '../../../../../public/ui.js';

export const enc = encodeURIComponent;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z/g;
const DAY_ONLY = /\b\d{4}-\d{2}-\d{2}\b(?!T)/g;
// The server's sentences carry exact times; they read as dates here.
export const readable = (s) => (typeof s === 'string' ? s.replace(ISO, (m) => fmtDateTime(m)).replace(DAY_ONLY, (m) => fmtDate(m)) : s);
export const pct = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(d)}%` : '—');
export const usd = (v) => (typeof v === 'number' && Number.isFinite(v) ? (Math.abs(v) >= 1000 ? fmtCompactUsd(v) : fmtPrice(v)) : '—');
export const words = (s) => (s ? s.replace(/_/g, ' ') : '');
// A one-time ID for each click, so a retry after a lost answer applies once.
export const requestId = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
