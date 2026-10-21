import { needsCount } from '../../../public/portfolio-model.js';
import { LayoutList, Inbox, Wallet, FlaskConical } from 'lucide-react';
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
export function navCounts(index, agenda = null) {
  if (!index) return {};
  const k = deskKpis(index, agenda);
  const pf = portfolioNeeds(index);
  const s = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return {
    review: k.review.projects ? { n: k.review.projects, title: `${s(k.review.projects, 'project needs', 'projects need')} your review` } : null,
    portfolio: pf ? { n: pf, title: `${s(pf, 'record needs', 'records need')} attention` } : null,
  };
}
