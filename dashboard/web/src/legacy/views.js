// The views the app still hosts from dashboard/public, loaded on demand with
// their stylesheets (scoped under .lg by the build, see scope-legacy.js).
// Migration order and status: dashboard/web/README.md.
import '../../../public/styles.css';
import '../../../public/position.css';
import '../../../public/chart.css';
import '../../../public/dex.css';
import '../../../public/brief.css';
import '../../../public/brief-views.css';
import '../../../public/explorer.css';
import './bridge.css';

export const LEGACY_VIEWS = {
  new: () => import('../../../public/views/intake.js').then((m) => m.renderIntake),
  project: () => import('../../../public/views/project.js').then((m) => m.renderProject),
  portfolio: () => import('../../../public/views/portfolio.js').then((m) => m.renderPortfolio),
  research: () => import('../../../public/views/research.js').then((m) => m.renderResearch),
  updates: () => import('../../../public/views/updates.js').then((m) => m.renderUpdates),
  settings: () => import('../../../public/views/settings.js').then((m) => m.renderSettings),
  explorer: () => import('../../../public/views/explorer.js').then((m) => m.renderExplorer),
};

// The research, sector and add-project dialogs, opened from React views too.
export { openResearchDialog, openSectorDialog, openAddProjectDialog, waitingActions } from '../../../public/views/dialogs.js';
