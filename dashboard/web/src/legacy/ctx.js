// The context the views in dashboard/public/views were written for (the
// former app shell's ctx), backed by the React app's desk client and router.
import { desk, api, ui, refresh, projectDetail } from '../lib/desk.js';
import { nav, navigate, hrefWith, routeKey, claimFocus } from '../lib/router.js';

export const legacyState = {
  renderReason: 'nav',
  focusClaimed: false,
  dirty: false,
};

// ctx.state as the views read it: the session and its token, the index, the
// route, why the page is drawn, and the search focus request.
const state = {
  get token() { return desk.token; },
  get session() { return desk.session; },
  get index() { return desk.index; },
  get projects() { return desk.projects; },
  get route() { return nav.route; },
  get renderReason() { return legacyState.renderReason; },
  get focusSearch() { return nav.focusSearch; },
  set focusSearch(v) { nav.focusSearch = Boolean(v); },
  get live() { return desk.live.mode === 'live'; },
  get ui() { return desk.ui; },
  get dirty() { return legacyState.dirty; },
};

export const legacyCtx = {
  api,
  state,
  ui,
  refresh,
  navigate,
  projectDetail,
  routeKey,
  hrefWith: (params) => hrefWith(params),
  markDirty: () => { legacyState.dirty = true; },
  claimFocus: () => {
    legacyState.focusClaimed = true;
    claimFocus();
  },
};
