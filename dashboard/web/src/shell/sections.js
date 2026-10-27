import { needsCount } from '../../../public/portfolio-model.js';
import { LayoutList, Inbox, Wallet, FlaskConical, LineChart, GitBranch } from 'lucide-react';
import { deskKpis } from '../../../public/watchlist-model.js';

// The rail's four daily places (DESIGN_AND_IA_BLUEPRINT.md §3.0; Eric,
// 2026-10-17): Desk (the watchlist's address, so every saved link keeps
// working), Review (replaces Updates and Agenda), Portfolio and Research.
// Preferences (a drawer, ⌘,) and the command menu (⌘K) sit at the rail's
// foot; New research is the command menu's "Research a project" and the
// Desk's "+ Add project"; Explorer lives under Preferences → Developer.
export const SECTIONS = [
  { id: 'watchlist', label: 'Desk', icon: LayoutList },
  { id: 'review', label: 'Review', icon: Inbox },
  { id: 'portfolio', label: 'Portfolio', icon: Wallet },
  { id: 'research', label: 'Research', icon: FlaskConical },
  // Outcomes and the Paper Book (L7, 2026-10-26): what Eric reads of the
  // desk's results, one click away. It is Research's Outcomes tab (report
  // returns against BTC and the paper positions), never Portfolio.
  { id: 'outcomes', label: 'Outcomes', icon: LineChart, href: '#/research?tab=outcomes' },
  // The Pipeline cockpit (2026-10-27): where the self-building codebase
  // stands (Track 1), read only.
  { id: 'pipeline', label: 'Pipeline', icon: GitBranch },
];

// Pages that are not on the rail keep their names for the window title.
export const PAGE_TITLES = { new: 'New research', explorer: 'Research Explorer', settings: 'Preferences', updates: 'Review', agenda: 'Review' };

export function visibleSections() {
  return SECTIONS;
}

// Portfolio records that need you: one per row of its Needs attention tab
// (public/portfolio-model.js, the same rule as the tab's own count).
export function portfolioNeeds(index) {
  return needsCount(index);
}

// A count beside a place only where it means "needs you" (§3.0): Review, the
// projects that need a review (D3: one project counts once); Portfolio, the
// records that need attention.
//
// The Review count is the queue Review draws (review-model.js reviewQueue,
// the same rule as deskKpis().review, tested in review-queue.test.js), read
// with the agenda. Until the agenda has answered, the count is "…" so it
// never shows one number and then another (L4, 2026-10-26).
export function navCounts(index, agenda = null, { settled = true } = {}) {
  if (!index) return {};
  const k = deskKpis(index, agenda);
  const pf = portfolioNeeds(index);
  const s = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return {
    review: !settled ? { n: '…', tone: 'is-caution', title: 'Counting the projects that need your review' }
      : k.review.projects ? { n: k.review.projects, tone: 'is-caution', title: `${s(k.review.projects, 'project needs', 'projects need')} your review` } : null,
    portfolio: pf ? { n: pf, tone: 'is-info', title: `${s(pf, 'record needs', 'records need')} attention` } : null,
  };
}
