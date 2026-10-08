// Holdings as ledger rows that never wrap into columns: the logo, the bold
// symbol with its account or network as a small pill, the name under it and
// the ledger's own facts as tags (cost, stale or missing price, in transit,
// quarantined); on the right the amount over its value. Amounts arrive
// rounded with the exact decimal as their tooltip and data-exact; a value the
// desk cannot price reads in words ("Value unknown"), never as zero. A row
// with more to say (price, allocation, results, fees, the BTC comparison, the
// split across accounts) folds it under Details, in words, so a phone reaches
// everything a wide table shows.
export function LedgerTable({ rows, label, empty = null }) {
  if (!rows.length) return empty ? <p className="faint">{empty}</p> : null;
  return (
    <ul className="ledger" aria-label={label}>
      {rows.map((r) => (
        <li key={r.id} className="ledger-row">
          <span className="ledger-logo">{r.logo}</span>
          <span className="ledger-main">
            <span className="ledger-top">
              {r.href ? <a className="ledger-sym" href={r.href} title={r.hrefTitle || undefined}>{r.symbol}</a> : <span className="ledger-sym">{r.symbol}</span>}
              {r.chip ? <span className="ledger-chip" title={r.chipTitle || undefined}>{r.chip}</span> : null}
            </span>
            {r.name ? <span className="ledger-name">{r.name}</span> : null}
            {r.tags && r.tags.length ? (
              <span className="ledger-tags">
                {r.tags.map((t) => <span key={t.text} className={`ledger-tag tone-${t.tone || 'none'}`} title={t.title || undefined}>{t.text}</span>)}
              </span>
            ) : null}
          </span>
          <span className="ledger-figs">
            <span className="ledger-amt" title={r.amountTitle || undefined} data-exact={r.amountExact ?? undefined}>{r.amount}</span>
            <span className={`ledger-val${r.valueKnown === false ? ' is-unknown' : ''}`} title={r.valueTitle || undefined}>{r.value}</span>
          </span>
          {r.facts && r.facts.length ? (
            <details className="ledger-more" data-key={`ledger-${r.id}`}>
              <summary>Details<span className="sr-only">{` for ${r.symbol}`}</span></summary>
              <dl>
                {r.facts.map((f) => (
                  <div key={f.k} className="ledger-fact">
                    <dt>{f.k}</dt>
                    <dd className={f.tone ? `tone-${f.tone}` : undefined} title={f.title || undefined}>{f.v}</dd>
                  </div>
                ))}
              </dl>
            </details>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
