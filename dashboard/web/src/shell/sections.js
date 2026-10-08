import { Eye, SquarePen, Wallet, FlaskConical, Inbox, Database, Settings } from 'lucide-react';
import { followedCount } from '../../../public/ui.js';

// The desk's pages, in the order the navigation shows them. Explorer appears
// only where the server says to show it (set up, or on this PC).
export const SECTIONS = [
  { id: 'watchlist', label: 'Watchlist', icon: Eye },
  { id: 'new', label: 'New research', icon: SquarePen },
  { id: 'portfolio', label: 'Portfolio', icon: Wallet },
  { id: 'research', label: 'Research', icon: FlaskConical },
  { id: 'updates', label: 'Updates', icon: Inbox },
  { id: 'explorer', label: 'Explorer', icon: Database },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function visibleSections(desk, active) {
  const show = desk.session && desk.session.explorer && desk.session.explorer.show;
  return SECTIONS.filter((s) => s.id !== 'explorer' || show || active === 'explorer');
}

// The counts beside the pages: projects you follow, research in progress,
// what changed since your review and what waits in the inbox.
export function navCounts(index) {
  if (!index) return {};
  const projects = (index.projects || []).filter((p) => !p.broken && p.status !== 'archived');
  const changed = projects.filter((p) => p.changes && p.changes.item_count > 0).length;
  const pending = ((index.imports && index.imports.requests_pending) || []).length + (((index.imports && index.imports.inbox) || {}).in_inbox || []).length;
  const running = projects.filter((p) => p.research && Object.values(p.research.providers || {}).some((j) => j && ['queued', 'running', 'dispatching'].includes(j.state))).length;
  const followed = followedCount(projects);
  const s = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return {
    watchlist: followed ? { n: followed, title: `${s(followed, 'project', 'projects')} you watch or hold` } : null,
    research: running ? { n: running, title: `${s(running, 'project', 'projects')} with research in progress` } : null,
    updates: changed + pending ? { n: changed + pending, title: `${s(changed, 'project', 'projects')} changed since your last review${pending ? `; ${s(pending, 'item', 'items')} waiting in the inbox or request queue` : ''}` } : null,
  };
}
