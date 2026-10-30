// The Desk's hero (Eric, 2026-10-26, after the platform's overview card; the
// Architecture restyle, 2026-10-29): the Daily Brief as the page's one black
// panel, the thing that needs Eric. Its readiness is read from GET
// /api/brief/daily (research waiting, exits missing, tickets waiting for
// you): each a large light numeral over its words; a section the desk could
// not read shows no numeral and says Unknown. Under them, Open Daily Brief
// (the ceramic primary pill) and the Review queue (an outline pill), counts
// only. While a project is docked beside the list the hero turns light, so
// the open drawer's foot stays the one black panel (tokens.css).
// Nothing here starts research, the pilot or a paid call; reading writes nothing.
import { ArrowRight } from 'lucide-react';
import { readiness } from '../../../../public/daily-brief-model.js';
import { useBriefRead } from '../../lib/brief.js';
import { openBrief } from '../../shell/overlays.js';
import { navigate } from '../../lib/router.js';

export function DeskHero({ reviewCount }) {
  const { view, error } = useBriefRead();
  const rows = readiness(view);
  const loading = !view && !error;
  const attention = view && view.ok ? view.sections.filter((s) => s.unreadable || s.partial || (!s.empty && (s.count || 0) > 0)).length : null;
  const briefWords = attention === null ? (error ? 'Could not be read' : '—') : `${attention} ${attention === 1 ? 'section' : 'sections'} to read`;
  const reviewWords = reviewCount === null ? 'Counting…' : `${reviewCount} ${reviewCount === 1 ? 'project' : 'projects'}`;
  return (
    <section className="hero" aria-label="Daily Brief">
      <div className="hero-mesh" aria-hidden="true" />
      <div className="hero-in">
        <div className="hero-ready">
          <p className="eyebrow hero-eyebrow">Needs you</p>
          <h2 className="hero-h">Daily Brief</h2>
          <ul className="ready" aria-busy={loading}>
            {rows.map((r) => {
              const words = loading ? 'Reading…' : r.words;
              const num = !loading && typeof r.n === 'number';
              return (
                <li key={r.key} className={`ready-item is-${loading ? 'loading' : r.state}`} title={r.why || undefined}>
                  <span className="ready-n" aria-hidden="true">{num ? r.n : '—'}</span>
                  <span className="ready-text">
                    <span className="ready-t">{r.title}</span>
                    <span className="ready-w">{words}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="hero-cards">
          <button type="button" className="btn hero-btn is-primary" data-key="hero-brief" onClick={() => openBrief()} aria-label={`Open Daily Brief: ${briefWords}`}>
            <span className="hero-btn-t">Open Daily Brief</span>
            <span className="hero-btn-s">{briefWords}</span>
            <ArrowRight className="hero-btn-go" size={16} aria-hidden="true" />
          </button>
          <button type="button" className="btn hero-btn is-outline" data-key="hero-review" onClick={() => navigate('#/review')} aria-label={`Review queue: ${reviewWords}`}>
            <span className="hero-btn-t">Review queue</span>
            <span className="hero-btn-s">{reviewWords}</span>
            <ArrowRight className="hero-btn-go" size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
}
