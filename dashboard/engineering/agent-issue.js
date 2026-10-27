'use strict';
// The Agent task issue for a desk draft (Engineering v3, change 6):
// engineering_prepare_task also returns the issue body, the problems main's
// own agent-guard taskOf finds in it, and a link that opens the Agent task
// form prefilled. The link carries no label: only Eric's own agent:build
// label on the version he submits authorizes a build. "Files to change" is
// the only path authority; anything else goes in Notes, which no check reads
// for permission. Nothing is sent anywhere: Eric opens the link himself.

const G = require('../scripts/agent-guard');
const P = require('./policy');

const FORM = 'agent-task.yml';
const NEW_ISSUE = `https://github.com/${P.REPO}/issues/new`;
const LINK_MAX = 8000;
const TEMPLATE_OF = { implement: 'eng-backend@1', design: 'eng-docs@1' };
// The form's field IDs (.github/ISSUE_TEMPLATE/agent-task.yml): ?template=
// names the form itself, so its Template dropdown is lane_template.
const IDS = { template: 'lane_template', outcome: 'outcome', acceptance: 'acceptance', negative: 'negative', tests: 'tests', paths: 'paths', notes: 'notes' };
const NO_TESTS = 'None: a documentation task (eng-docs@1 has no behavior to test).';

const bullets = (xs) => xs.map((x) => `- ${x}`).join('\n');
const linkOf = (params) => `${NEW_ISSUE}?${Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;

// The draft's own normalized content (policy.js contentOf, what the desk
// hashes) plus `tests`, which only the issue carries. original_instruction
// stays on the desk: it is never read here.
function agentIssue(args = {}, { policy = G.loadPolicy() } = {}) {
  const c = P.contentOf(args);
  if (c.intent === 'explore') return { ok: false, refused: 'explore is a note: the agent lane never builds it, so there is no issue to open' };
  const template = TEMPLATE_OF[c.intent];
  if (!template) return { ok: false, refused: `an Agent task is implement (${TEMPLATE_OF.implement}) or design (${TEMPLATE_OF.design})` };
  const tests = (Array.isArray(args.tests) ? args.tests : []).map((x) => String(x).trim()).filter(Boolean);
  const paths = c.scope.paths;
  const fields = {
    template,
    outcome: c.outcome,
    acceptance: bullets(c.acceptance),
    negative: bullets(c.non_goals),
    tests: tests.length ? bullets(tests) : template === 'eng-docs@1' ? NO_TESTS : '',
    paths: bullets(paths),
    notes: c.dependencies.length ? `Merged first: ${c.dependencies.join(', ')}.` : '',
  };
  const body = Object.entries(G.FIELDS).map(([k, label]) => `### ${label}\n\n${fields[k] || '_No response_'}`).join('\n\n');

  // Read back as the lane reads it, and as given: a line that starts a
  // section of its own (### ) would change another field.
  const task = G.taskOf({ number: null, title: c.title, body }, { policy });
  const problems = [...task.problems];
  for (const k of ['template', 'outcome', 'acceptance', 'negative', 'notes']) if (task[k] !== fields[k]) problems.push(`"${G.FIELDS[k]}" does not read back as given: a line in a field starts a section of its own`);
  if (JSON.stringify(task.paths) !== JSON.stringify(paths)) problems.push(`"${G.FIELDS.paths}" does not read back as given: one repository path per line, with no spaces`);
  for (const t of tests) {
    if (!task.tests.includes(t)) problems.push(`${t} is not a test file under dashboard/tests/ (dashboard/tests/<name>.test.js)`);
    else if (!paths.some((p) => P.within(t, p))) problems.push(`the regression test ${t} is not under "${G.FIELDS.paths}", so the build could not change it`);
  }
  for (const w of P.screen(body).filter((x) => !/web address/.test(x))) problems.push(`the body holds ${w}; keep it out of the public repository`);

  const params = { template: FORM, title: c.title };
  for (const [k, id] of Object.entries(IDS)) params[id] = fields[k];
  const full = linkOf(params);
  const link = full.length <= LINK_MAX ? full : null;
  const unique = [...new Set(problems)];
  return {
    ok: unique.length === 0,
    template,
    title: c.title,
    body,
    problems: unique,
    link,
    link_chars: full.length,
    form: linkOf({ template: FORM }),
    says: [
      unique.length ? `The agent lane would refuse this task as it stands (${unique.length} ${unique.length === 1 ? 'problem' : 'problems'}).` : 'The agent lane reads this task with no problems.',
      link
        ? `Eric opens the link, checks every field (Template ${template}: whether GitHub preselects a dropdown from the link is unverified), submits the issue and adds the agent:build label himself; nothing is built before that.`
        : `The prefilled link would be ${full.length} characters, over ${LINK_MAX}: Eric opens the empty Agent task form and pastes each section of the body, then adds the agent:build label himself.`,
    ].join(' '),
  };
}

module.exports = { FORM, NEW_ISSUE, LINK_MAX, TEMPLATE_OF, IDS, NO_TESTS, agentIssue };
