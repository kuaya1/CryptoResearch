// Parts and dialogs the React views reuse from the hosted views, loaded on
// demand with their scoped stylesheets (views.js imports them).
export * from './views.js';
export { dexCard, dexLink, dexTargets, lookupTargets, peekLookup, topPool, THIN_USD } from '../../../public/views/dex.js';
export { technicalChart } from '../../../public/views/chart.js';
export {
  evidenceChecksBlock, sourceItem, promptView, evidenceTab, reportsTab, marketTab, historyTab, scorecardBody, headlineBody,
  researchParts, latestReports, checksWord,
} from '../../../public/views/project.js';
export { comparePanel } from '../../../public/views/brief-compare.js';
export { importTab, inboxTab, requestsTab } from '../../../public/views/updates.js';
export { prefsSection } from '../../../public/views/settings.js';
export { chartCycleBlock, codeReviewBlock } from '../../../public/thesis-ui.js';
export { positionFacts, vsBtcFacts, marketStrip } from '../../../public/position-ui.js';
export { structureNotes, h } from '../../../public/ui.js';
