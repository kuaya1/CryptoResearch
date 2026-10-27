// The Desk's hero (Eric, 2026-10-26, after the platform's overview card): a
// quiet mesh behind the Daily Brief's readiness, three 40px circles read from
// GET /api/brief/daily (research waiting, exits missing, tickets waiting for
// you), each a count with its word; a section the desk could not read says
// Unknown. Beside them, the Daily Brief and the Review queue, counts only.
// Nothing here starts research, the pilot or a paid call; reading writes nothing.
import { ArrowRight, FlaskConical, ShieldCheck, Ticket, Newspaper, Inbox } from 'lucide-react';
import { readiness } from '../../../../public/daily-brief-model.js';
import { useBriefRead } from '../../lib/brief.js';
import { openBrief } from '../../shell/overlays.js';
import { navigate } from '../../lib/router.js';

const ICONS = { research: FlaskConical, forensics: ShieldCheck, tickets: Ticket };

export function DeskHero({ reviewCount }) {
  const { view, error } = useBriefRead();
  const rows = readiness(view);
  const loading = !view && !error;
  const attention = view && view.ok ? view.sections.filter((s) => s.unreadable || s.partial || (!s.empty && (s.count || 0) > 0)).length : null;
  return (
    <section className="hero" aria-label="Daily Brief">
      <div className="hero-mesh" aria-hidden="true" />
      <div className="hero-in">
        <div className="hero-ready">
          <h2 className="hero-h">Daily Brief</h2>
          <ul className="ready" aria-busy={loading}>
            {rows.map((r) => {
              const Icon = ICONS[r.key];
              const words = loading ? 'Reading…' : r.words;
              return (
                <li key={r.key} className={`ready-item is-${loading ? 'loading' : r.state}`} title={r.why || undefined}>
                  <span className="ready-dot" aria-hidden="true">
                    {r.n ? <span className="ready-n">{r.n}</span> : <Icon size={18} strokeWidth={1.8} />}
                  </span>
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
          <button type="button" className="mini" data-key="hero-brief" onClick={() => openBrief()}>
            <span className="mini-ico" aria-hidden="true"><Newspaper size={18} strokeWidth={1.8} /></span>
            <span className="mini-text">
              <span className="mini-t">Open Daily Brief</span>
              <span className="mini-s">{attention === null ? (error ? 'Could not be read' : '—') : `${attention} ${attention === 1 ? 'section' : 'sections'} to read`}</span>
            </span>
            <ArrowRight className="mini-go" size={16} aria-hidden="true" />
          </button>
          <button type="button" className="mini" data-key="hero-review" onClick={() => navigate('#/review')}>
            <span className="mini-ico" aria-hidden="true"><Inbox size={18} strokeWidth={1.8} /></span>
            <span className="mini-text">
              <span className="mini-t">Review queue</span>
              <span className="mini-s">{reviewCount === null ? 'Counting…' : `${reviewCount} ${reviewCount === 1 ? 'project' : 'projects'}`}</span>
            </span>
            <ArrowRight className="mini-go" size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
}
