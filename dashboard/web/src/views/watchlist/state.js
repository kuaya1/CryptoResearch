// The watchlist's own state between redraws and visits (the search, the row
// order you are reading, which model each project's inspector shows, where
// focus returns), and the inspector's way in and out:
// - opening adds one history entry (so Back closes it); switching to another
//   project while it is open replaces that entry;
// - a peek (the keyboard, beside the list) leaves focus on the list;
// - closing goes back to the entry the inspector came from when it added one.
import { toast } from '../../../../public/ui.js';
import { needsReview, nextToReview } from '../../../../public/watchlist-model.js';
import { desk, api, refresh } from '../../lib/desk.js';
import { seenOf, sendReview, undoReview, newRequestId, STILL_LOADING } from '../../lib/review.js';
import { nav, navigate, hrefWith } from '../../lib/router.js';

export const view = {
  q: '',
  order: null,        // the project IDs in the order shown
  orderKey: '',       // the sort, filters and search that order was made for
  orderIndex: null,   // the index it was made from
  returnFocus: null,  // data-key of the control that opened the inspector
  focusProvider: null,
  focusOnRender: false,
  recent: null,       // the project last shown in the inspector
  inspectorTab: {},   // project ID -> the model chosen in its inspector
  strip: null,        // the status strip's open part
  stripReady: false,
  peek: false,
};

export const isWide = () => window.matchMedia('(min-width: 1280px)').matches;

export function openPanel(pid, opener = null, provider = null, { peek = false } = {}) {
  view.returnFocus = opener && opener.dataset ? opener.dataset.key || null : null;
  view.focusProvider = provider;
  view.focusOnRender = !peek;
  view.peek = peek;
  if (provider) view.inspectorTab[pid] = provider;
  const open = nav.route.query.get('p');
  if (open === pid) {
    navigate(hrefWith({ p: pid }), { replace: true, state: history.state });
    return;
  }
  if (open) navigate(hrefWith({ p: pid }), { replace: true, state: history.state });
  else navigate(hrefWith({ p: pid }), { state: { crPanel: pid } });
}

export function closePanel() {
  if (history.state && history.state.crPanel) history.back();
  else navigate(hrefWith({ p: null }), { replace: true });
}

// Mark reviewed (only with changes to review; the menu's item always) with
// the reports the inspector drew (lib/review.js), offer Undo for six seconds,
// and with `advance` move to the next project in the list's order that has
// changes to review ("All caught up" when none). Nothing is marked while the
// opinion is still loading, and a newer report than the one drawn is said,
// never marked. A lost answer offers Try again with the same request.
export async function markReviewed(p, { advance = false, onBusy = null, force = false, retry = null } = {}) {
  if (!force && !retry && !needsReview(p)) return;
  const pid = p.project_id;
  const drawn = retry || seenOf(p, desk.projects.get(pid) || null);
  if (!drawn.ready) {
    toast(STILL_LOADING);
    return;
  }
  const requestId = (retry && retry.requestId) || newRequestId();
  const order = view.order || [];
  const next = advance ? nextToReview(order, desk.index.projects, pid) : null;
  if (onBusy) onBusy(true);
  let out;
  try {
    out = await sendReview(pid, { seen: drawn.seen, requestId });
  } finally {
    if (onBusy) onBusy(false);
  }
  if (out.kind === 'signed_out') return;
  if (out.kind === 'no_answer') {
    toast(out.message, 'bad', { action: { label: 'Try again', key: 'retry-review', onClick: () => markReviewed(p, { advance, onBusy, retry: { ready: true, seen: drawn.seen, requestId } }) } });
    return;
  }
  if (out.kind === 'refused') {
    toast(out.message, 'bad');
    return;
  }
  if (out.kind === 'newer') {
    const first = out.newer.find((n) => n.report_id) || null;
    toast(out.message, 'bad', {
      action: {
        label: 'Show it',
        key: 'show-newer',
        onClick: async () => {
          if (first) view.inspectorTab[pid] = first.provider;
          await refresh();
        },
      },
    });
    return;
  }
  const res = out.result;
  if (out.kind === 'unchanged') toast(out.message);
  else {
    toast(`Marked ${p.name} reviewed`, '', {
      ms: 6000,
      action: {
        label: 'Undo',
        key: 'undo-review',
        onClick: async () => {
          await undoReview(pid, res);
          toast(`${p.name}: review undone`);
          await refresh();
        },
      },
    });
  }
  if (advance) {
    if (next) {
      const name = document.querySelector(`[data-key="pname-${CSS.escape(next)}"]`);
      openPanel(next, name, null, { peek: isWide() });
    } else toast('All caught up');
  }
  await refresh();
}

export async function restoreProject(p) {
  try {
    const r = await api.post(`/api/projects/${encodeURIComponent(p.project_id)}/restore`, {});
    toast(`Restored ${p.name}${r.on_watchlist ? ', back on your watchlist' : ''}. Nothing was started or sent.${(r.held_jobs || []).length ? ' Research held while it was archived stays unsent until you send it.' : ''}`);
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

// Archive: no confirmation, an Undo in the notice, Restore under the Archived
// filter. A request already sent to a paid model may still finish and be billed.
export async function archiveProject(p) {
  try {
    const r = await api.post(`/api/projects/${encodeURIComponent(p.project_id)}/archive`, { reason: 'Archived from the dashboard' });
    const sent = (r.sent_jobs || []).length;
    toast(`Archived ${p.name}. It is off your watchlist; its reports, notes and any holding are kept.${sent ? ` ${sent} request${sent === 1 ? '' : 's'} already sent to a paid model may still finish and be billed.` : ''}`, '', { action: { label: 'Undo', key: `undo-archive-${p.project_id}`, onClick: () => restoreProject(p) } });
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

export async function setWatching(p, on) {
  try {
    await api.post(`/api/projects/${encodeURIComponent(p.project_id)}/watchlist`, { on });
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
}
