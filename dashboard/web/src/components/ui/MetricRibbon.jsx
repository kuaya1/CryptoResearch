// A row of key figures in equal cells divided by hairlines (the terminal's
// metric ribbon): a small label over its tabular value. A value the desk does
// not hold arrives as its own "—" with the reason (figures.jsx Unknown), never
// a zero. The 10px uppercase labels are this ribbon's recorded exception to
// "nothing under 12px, sentence case" (Eric, 2026-10-08 polish); a screen
// reader hears each label and value as a term and its definition.
export function MetricRibbon({ items, label }) {
  return (
    <dl className="mribbon" aria-label={label}>
      {items.map((it) => (
        <div key={it.key || it.label} className="mribbon-cell" title={it.title || undefined}>
          <dt>{it.label}</dt>
          <dd>{it.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
