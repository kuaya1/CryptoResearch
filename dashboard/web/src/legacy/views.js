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
// The hosted pages at the executive scale (unscoped; after the scoped sheets).
import '../styles/legacy-pages.css';
import { retryingImport } from '../components/Boundary.jsx';

// Each page's code is asked for again after a failed download (a fresh
// request; browsers keep a failed module fetch otherwise; review 2026-10-08, F3).
const intake = retryingImport(() => import('../../../public/views/intake.js'));
const project = retryingImport(() => import('../../../public/views/project.js'));
const portfolio = retryingImport(() => import('../../../public/views/portfolio.js'));
const research = retryingImport(() => import('../../../public/views/research.js'));
const updates = retryingImport(() => import('../../../public/views/updates.js'));
const settings = retryingImport(() => import('../../../public/views/settings.js'));
const explorer = retryingImport(() => import('../../../public/views/explorer.js'));
export const LEGACY_VIEWS = {
  new: () => intake().then((m) => m.renderIntake),
  project: () => project().then((m) => m.renderProject),
  portfolio: () => portfolio().then((m) => m.renderPortfolio),
  research: () => research().then((m) => m.renderResearch),
  updates: () => updates().then((m) => m.renderUpdates),
  settings: () => settings().then((m) => m.renderSettings),
  explorer: () => explorer().then((m) => m.renderExplorer),
};

// The research, sector and add-project dialogs, opened from React views too.
export { openResearchDialog, openSectorDialog, openAddProjectDialog, waitingActions } from '../../../public/views/dialogs.js';
