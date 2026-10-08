import { badgeRank } from '../../../../public/watchlist-model.js';

// GoPlus's four standing checks as one audit strip (Eric, 2026-10-08): Mint,
// Blacklist (Freeze on Solana), Proxy and Tax in equal cells, "Mint: No" in
// quiet slate; only a risky answer becomes a red alert badge inside its cell.
// An unanswered check reads "—" (its label says so), never "No"; an unknown
// tax is never "0%"; "n/a" for a native coin. Severe flags and a recent change
// follow as full-width alert rows, the most severe first. Nothing is ever
// labelled safe. `model` is watchlist-model.js contractChipModel's answer.
export function SecurityAuditStrip({ model }) {
  const extra = [...(model.extra || [])].sort((a, b) => badgeRank(a) - badgeRank(b));
  return (
    <>
      <ul className="cc-audit" aria-label="Contract checks from GoPlus">
        {model.chips.map((c) => (
          <li key={c.key} className={`cc-cell is-${c.dot}`} title={c.title || undefined} aria-label={c.aria}>
            <span className={c.dot === 'risky' ? 'cc-alert' : 'cc-quiet'} aria-hidden="true"><span className="cc-l">{`${c.label}:`}</span> <span className="cc-val">{c.value}</span></span>
          </li>
        ))}
      </ul>
      {extra.length ? (
        <ul className="sa-crit" aria-label="Severe contract flags from GoPlus">
          {extra.map((b) => (
            <li key={b.key} className="sa-crit-row" title={b.title} aria-label={b.aria}>
              <span className="sa-crit-dot" aria-hidden="true" />
              <span aria-hidden="true">
                <span className="sa-crit-k">{b.key === 'alert' ? 'Changed' : 'Severe'}</span>
                {b.key === 'alert' ? (b.value ? `: ${b.value}` : '') : `: ${b.label}${b.value ? ` (${b.value.replace(/^\+/, '')} more)` : ''}`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
