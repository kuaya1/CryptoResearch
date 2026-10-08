// Parts and dialogs the React views reuse from the hosted views, loaded on
// demand with their scoped stylesheets (views.js imports them).
export * from './views.js';
export { dexCard, dexLink } from '../../../public/views/dex.js';
export { technicalChart } from '../../../public/views/chart.js';
export {
  evidenceChecksBlock, sourceItem, promptView, evidenceTab, reportsTab, marketTab, historyTab, scorecardBody, headlineBody,
  researchParts, latestReports, checksWord,
} from '../../../public/views/project.js';
export { comparePanel } from '../../../public/views/brief-compare.js';
export { chartCycleBlock } from '../../../public/thesis-ui.js';
export { positionFacts, vsBtcFacts, marketStrip } from '../../../public/position-ui.js';
export { structureNotes, h } from '../../../public/ui.js';
