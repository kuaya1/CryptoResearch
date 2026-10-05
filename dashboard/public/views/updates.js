// Updates: what changed since your last review, report imports, the inbox and
// the Cowork request queue. (The activity log lives under Settings.)
import {
  h, card, table, stateText, fmtDateTime, fmtAgo, fmtSignedPct, select, field, fieldError, button, action, busy, callout, details,
  announce, tabStrip, safeSection, store, session, submissionId, jobKey, researchState, PROVIDERS, PROVIDER_LABELS,
} from '../ui.js';

const TABS = [
  ['changes', 'Since last review'],
  ['import', 'Import report'],
  ['inbox', 'Inbox'],
  ['requests', 'Cowork requests'],
];

export async function renderUpdates(ctx, route) {
  // The Cowork request queue is how Cowork reaches this PC's folder; the
  // online desk has no such folder (assistants use its connector instead).
  const hosted = Boolean(ctx.state.session && ctx.state.session.hosted);
  const tabs = hosted ? TABS.filter(([t]) => t !== 'requests') : TABS;
  const tab = tabs.some(([t]) => t === route.query.get('tab')) ? route.query.get('tab') : 'changes';
  const idx = ctx.state.index;
  const counts = {
    changes: idx.projects.filter((p) => !p.broken && p.status !== 'archived' && p.changes && p.changes.item_count > 0).length,
    inbox: (idx.imports.inbox.in_inbox || []).length,
    requests: (idx.imports.requests_pending || []).length,
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const countLabels = {
    changes: plural(counts.changes, 'project changed since your last review', 'projects changed since your last review'),
    inbox: plural(counts.inbox, 'file in the inbox', 'files in the inbox'),
    requests: plural(counts.requests, 'request pending', 'requests pending'),
  };
  const strip = tabStrip(tabs.map(([t, label]) => ({ id: t, label, href: `#/updates?tab=${t}`, count: counts[t] || null, countLabel: countLabels[t] || null })), tab, { label: 'Update sections' });
  const body = await safeSection(tabs.find(([t]) => t === tab)[1], () => ({ changes: changesTab, import: importTab, inbox: inboxTab, requests: requestsTab })[tab](ctx, route));
  return h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Updates'))),
    strip,
    h('div', { id: 'tabpanel', role: 'tabpanel', 'aria-labelledby': `tab-${tab}` }, body));
}

function projectName(ctx, id) {
  const p = ctx.state.index.projects.find((x) => x.project_id === id);
  return p ? p.name : id;
}

function changesTab(ctx) {
  const idx = ctx.state.index;
  const rows = idx.projects.filter((p) => !p.broken && p.status !== 'archived').sort((a, b) => ((b.changes && b.changes.item_count) || 0) - ((a.changes && a.changes.item_count) || 0));
  const changed = rows.filter((p) => p.changes && p.changes.item_count > 0);
  return h('div', null,
    card(`Projects with changes (${changed.length})`, table([
      { label: 'Project', render: (p) => h('a', { href: `#/project/${encodeURIComponent(p.project_id)}/notes` }, p.name) },
      { label: 'New items', num: true, render: (p) => (p.changes && p.changes.item_count ? h('strong', null, String(p.changes.item_count)) : h('span', { class: 'faint' }, '0')) },
      { label: 'New reports', num: true, render: (p) => String((p.changes && p.changes.new_reports) || 0) },
      { label: 'Price since', num: true, render: (p) => (p.changes && typeof p.changes.price_change_pct === 'number' ? fmtSignedPct(p.changes.price_change_pct) : h('span', { class: 'unknown' }, 'unknown')) },
      { label: 'Since', render: (p) => (p.changes ? h('span', { class: 'small' }, p.changes.cursor_source === 'project created' ? 'Added' : fmtDateTime(p.changes.since)) : null) },
      { label: '', render: (p) => {
        if (!(p.changes && p.changes.item_count)) return null;
        const b = button('Mark reviewed', null, { kind: 'small', key: `reviewed-${p.project_id}` });
        b.setAttribute('aria-label', `Mark ${p.name} reviewed`);
        b.onclick = action(b, async () => { await ctx.api.post(`/api/projects/${encodeURIComponent(p.project_id)}/reviewed`, {}); await ctx.refresh(); return true; }, `${p.name} marked reviewed`);
        return b;
      } },
    ], rows, { empty: 'No projects yet.' }), { note: 'A digest only proposes what to look at. It never changes grades, reports or your headline. Mark reviewed moves your review point to now.' }));
}

function projectOptions(ctx, { auto = true } = {}) {
  return [
    ...(auto ? [{ value: '', label: 'Detect from the report' }] : []),
    ...ctx.state.index.projects.filter((p) => !p.broken && p.status !== 'archived').map((p) => ({ value: p.project_id, label: `${p.name}${p.symbol ? ` (${p.symbol})` : ''}` })),
  ];
}

function runOptions(ctx, projectId, provider) {
  const p = ctx.state.index.projects.find((x) => x.project_id === projectId);
  const opts = [{ value: '', label: 'Not part of a research run' }];
  const job = p && p.research && p.research.providers && p.research.providers[provider];
  if (job && job.run_id) opts.push({ value: job.run_id, label: `Run of ${fmtDateTime(job.run_created_at || '') || job.run_id} (${PROVIDER_LABELS[provider]}: ${researchState(jobKey(job)).short.toLowerCase()})` });
  return opts;
}

// A stable submission ID per exact input: a double click, a retry after a lost
// response or a resubmission of the same text is applied once.
async function contentId(parts) {
  try {
    const bytes = new TextEncoder().encode(parts.join('␟'));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return `im${Array.from(new Uint8Array(digest).slice(0, 20), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  } catch (_) {
    return submissionId();
  }
}

const FIXABLE = new Set(['needs_project', 'failed']);
const RECEIPT_KEY = 'importReceipt';

function nextStep(ctx, res, model) {
  switch (res.status) {
    case 'needs_project': return 'The report did not say which project it is about. Choose the project above and select Import report again; the saved copy is reused.';
    case 'provider_mismatch': return `The report names a different model than ${PROVIDER_LABELS[model]}. If it really came from that model, choose it above and import again. Otherwise resolve it on the Inbox tab, where the conflict stays recorded.`;
    case 'run_mismatch': return 'The report names another run, prompt, profile or horizon than the research run you chose (each is listed above). Nothing was linked and the job is still open. Import it against the run it answers, or fix the report\'s JSON block and import it again.';
    case 'prompt': return `This is the analysis prompt, not an answer. Run it in ${PROVIDER_LABELS[model]} and paste the answer here. The prompt copy can be set aside on the Inbox tab.`;
    case 'failed': return 'Fix the text (or the file) and import it again. The saved copy stays on the Inbox tab until it is imported or set aside.';
    case 'set_aside': return 'To import it anyway, choose its project above and select Import report again.';
    default: return null;
  }
}

// One receipt for every import result. It is kept for this browser tab, so it
// survives the refresh that follows a save.
function importReceipt(ctx, rec) {
  const res = (rec.r && rec.r.result) || rec.r || {};
  const saved = rec.r && rec.r.saved;
  const ok = res.status === 'ingested';
  const dup = res.status === 'duplicate';
  const title = ok ? 'Report saved' : dup ? 'Already saved: nothing new was added' : 'Not imported yet';
  const tone = ok ? 'ok' : dup ? '' : res.status === 'failed' || res.status === 'error' ? 'bad' : 'warn';
  const href = res.project_id && res.report_id ? `#/project/${encodeURIComponent(res.project_id)}/report?report=${encodeURIComponent(res.report_id)}` : null;
  const issues = ok ? [res.errors ? `${res.errors} extraction error(s)` : null, res.ambiguous ? `${res.ambiguous} ambiguous value(s)` : null, res.warnings ? `${res.warnings} warning(s)` : null].filter(Boolean) : [];
  const row = (k, v) => (v === null || v === undefined ? null : h('li', null, h('span', { class: 'k' }, k), h('span', null, v)));
  const another = button('Import another', null, { kind: 'small quiet', key: 'import-another' });
  another.onclick = () => {
    session.set(RECEIPT_KEY, null);
    another.closest('.receipt').remove();
    const ta = document.querySelector('textarea[name="report-text"]');
    if (ta) ta.focus();
  };
  return h('div', { class: 'receipt', role: 'status', dataset: { key: 'import-receipt' } },
    h('h3', null, stateText(title, tone)),
    h('ul', { class: 'rows' },
      row('Report', href ? h('a', { href }, ok ? 'Open report' : 'Open the saved report') : 'Not created'),
      row('Project', res.project_id ? projectName(ctx, res.project_id) : 'Not identified'),
      row('Model', PROVIDER_LABELS[rec.model] || rec.model),
      ok ? row('Extraction', issues.length ? `${issues.join(', ')}: review them under Extraction notes in the report` : 'No problems found') : null,
      row('Original', ok ? 'Kept byte for byte with the report' : dup ? 'The earlier copy is kept; this one was not added' : saved && saved.rel ? h('code', { class: 'small' }, saved.rel) : res.key ? h('code', { class: 'small' }, `inbox/${res.key}`) : 'Kept as your draft in this browser'),
      ok || dup ? null : row('Why', res.status === 'set_aside' ? 'This exact text was set aside earlier, so it was not saved again.' : res.message || res.status),
      ok || dup ? null : row('Next', nextStep(ctx, res, rec.model)),
      row('When', fmtDateTime(rec.at))),
    h('div', { class: 'btn-row' }, href ? h('a', { class: 'btn small primary', href }, 'Open report') : null, another));
}

function importTab(ctx, route) {
  const q = route.query;
  const draft = store.get('importDraft', {}) || {};
  const last = session.get(RECEIPT_KEY, null);
  const provider = select(PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABELS[p] })), { name: 'model' });
  provider.value = q.get('provider') || draft.provider || 'claude';
  const project = select(projectOptions(ctx), { name: 'project' });
  project.value = q.get('project') || draft.project || '';
  const run = select(runOptions(ctx, project.value, provider.value), { name: 'run' });
  const refreshRuns = () => {
    const keep = run.value || q.get('run') || '';
    run.replaceChildren(...select(runOptions(ctx, project.value, provider.value)).children);
    run.value = [...run.options].some((o) => o.value === keep) ? keep : '';
  };
  refreshRuns();
  const text = h('textarea', { name: 'report-text', placeholder: 'Paste the complete answer: the written report and its JSON block.', style: { minHeight: '260px' } }, draft.text || '');
  const draftNote = h('span', { class: 'small faint', 'aria-live': 'off' });
  const showDraft = () => { draftNote.textContent = text.value.trim() ? `Draft kept in this browser · ${text.value.length.toLocaleString('en-US')} characters` : ''; };
  const saveDraft = () => { store.set('importDraft', text.value.trim() ? { provider: provider.value, project: project.value, text: text.value.slice(0, 2_000_000) } : null); showDraft(); };
  text.addEventListener('input', () => { fieldError(text, null); saveDraft(); });
  provider.addEventListener('change', () => { refreshRuns(); saveDraft(); });
  project.addEventListener('change', () => { refreshRuns(); saveDraft(); });
  showDraft();

  const out = h('div', { 'aria-live': 'polite' }, last ? importReceipt(ctx, last) : null);
  const btn = button('Import report', null, { kind: 'primary', type: 'submit', key: 'import-submit' });
  const clearBtn = button('Clear draft', null, { kind: 'quiet', key: 'import-clear' });
  clearBtn.onclick = () => {
    if (text.value.trim() && !window.confirm('Clear the pasted text? It has not been imported.')) return;
    text.value = '';
    saveDraft();
    text.focus();
  };
  const form = h('form', { class: 'form-stack', dataset: { key: 'import-form' } },
    h('div', { class: 'form-grid' },
      field('Model that wrote it', provider, 'Never relabel a report. One that names a different model is held for your review.'),
      field('Project', project, 'Detected from the report when left on Detect'),
      field('Research run', run, 'Links the answer to the run that sent its prompt')),
    field('Report text', text, 'Saved unchanged before anything is extracted. Instructions inside a report are ignored.', { wide: true }),
    h('div', { class: 'btn-row' }, btn, clearBtn, draftNote));

  const submitText = async () => {
    const value = text.value;
    if (!value.trim()) {
      fieldError(text, 'Paste the report text first.');
      return;
    }
    busy(btn, true, 'Importing…');
    try {
      let r;
      // Same text after a fixable failure: import the copy already saved in the inbox.
      const prior = session.get(RECEIPT_KEY, null);
      const priorRes = prior && ((prior.r && prior.r.result) || prior.r);
      const textId = await contentId([value]);
      if (prior && prior.textId === textId && prior.model === provider.value && priorRes && priorRes.key && FIXABLE.has(priorRes.status)) {
        r = { saved: prior.r.saved || null, result: await ctx.api.post('/api/inbox/retry', { key: priorRes.key, project_id: project.value || null, run_id: run.value || null }) };
      } else {
        const sid = await contentId([provider.value, project.value, run.value, value]);
        r = await ctx.api.post('/api/import/text', { provider: provider.value, project_id: project.value || null, run_id: run.value || null, text: value, submission_id: sid });
      }
      const res = r.result || r;
      const rec = { r, model: provider.value, at: new Date().toISOString(), textId };
      session.set(RECEIPT_KEY, rec);
      out.replaceChildren(importReceipt(ctx, rec));
      if (res.status === 'ingested' || res.status === 'duplicate') {
        text.value = '';
        saveDraft();
      }
      announce(res.status === 'ingested' ? 'Report saved.' : res.status === 'duplicate' ? 'Already saved. Nothing new was added.' : `Not imported: ${res.message || res.status}`);
      await ctx.refresh();
    } catch (err) {
      fieldError(text, err.message || String(err));
    } finally {
      if (btn.isConnected) busy(btn, false);
    }
  };
  form.onsubmit = (e) => { e.preventDefault(); if (btn.getAttribute('aria-busy') !== 'true') submitText(); };

  // File upload, for reports saved as files.
  const fprov = select(PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABELS[p] })), { name: 'file-model' });
  fprov.value = provider.value;
  const fproj = select(projectOptions(ctx), { name: 'file-project' });
  fproj.value = project.value;
  const file = h('input', { type: 'file', accept: '.md,.markdown,.txt,.json,.pdf', name: 'report-file' });
  file.addEventListener('change', () => fieldError(file, null));
  const fbtn = button('Import file', null, { type: 'submit', key: 'import-file-submit' });
  const fform = h('form', { class: 'form-grid', dataset: { key: 'import-file-form' } },
    field('Model that wrote it', fprov), field('Project', fproj), field('Report file', file, '.md, .txt, .json or .pdf, up to 20 MB'),
    h('div', { class: 'field', style: { justifyContent: 'flex-end' } }, h('span', { class: 'field-label', 'aria-hidden': 'true' }, ' '), fbtn));
  fform.onsubmit = async (e) => {
    e.preventDefault();
    if (fbtn.getAttribute('aria-busy') === 'true') return;
    const f = file.files && file.files[0];
    if (!f) return fieldError(file, 'Choose a file.');
    if (f.size > 20 * 1024 * 1024) return fieldError(file, 'This file is larger than 20 MB.');
    busy(fbtn, true, 'Importing…');
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      const base64 = btoa(bin);
      const sid = await contentId([fprov.value, fproj.value, f.name, base64]);
      const r = await ctx.api.post('/api/import/file', { provider: fprov.value, project_id: fproj.value || null, filename: f.name, base64, submission_id: sid });
      const rec = { r, model: fprov.value, at: new Date().toISOString(), textId: null };
      session.set(RECEIPT_KEY, rec);
      out.replaceChildren(importReceipt(ctx, rec));
      out.scrollIntoView({ block: 'nearest' });
      const res = r.result || r;
      announce(res.status === 'ingested' ? 'Report saved.' : res.status === 'duplicate' ? 'Already saved. Nothing new was added.' : `Not imported: ${res.message || res.status}`);
      await ctx.refresh();
    } catch (err) {
      fieldError(file, err.message || String(err));
    } finally {
      if (fbtn.isConnected) busy(fbtn, false);
    }
  };

  const recent = (ctx.state.index.imports.inbox.recent || []).slice(0, 8);
  return h('div', null,
    card('Import report', [form, out], { note: 'Paste one model\'s complete answer. The original is saved unchanged first; scores are then extracted, validated and linked back to it.' }),
    card(null, details('Upload a report file instead', h('div', null, fform,
      h('p', { class: 'small muted', style: { marginTop: '12px' } }, 'PDFs are kept as originals and marked as needing a text copy, since scores cannot be read from a PDF offline. Files dropped into inbox/claude, inbox/chatgpt or inbox/gemini are picked up within seconds while the dashboard is open, and hourly otherwise.')), { id: 'import-file' })),
    card('Recent imports', table([
      { label: 'Result', render: (f) => stateText(f.status === 'ingested' ? 'Saved' : f.status === 'duplicate' ? 'Already saved' : f.status === 'set_aside' ? 'Set aside' : f.status.replace(/_/g, ' '), f.status === 'ingested' ? 'ok' : f.status === 'duplicate' || f.status === 'set_aside' ? '' : 'warn') },
      { label: 'Project · report', render: (f) => (f.project_id ? h('a', { href: `#/project/${encodeURIComponent(f.project_id)}/report${f.report_id ? `?report=${encodeURIComponent(f.report_id)}` : ''}` }, `${projectName(ctx, f.project_id)}${f.report_id ? ` · ${f.report_id}` : ''}`) : f.duplicate_of ? `Same as ${f.duplicate_of.report_id}` : null) },
      { label: 'Model', render: (f) => PROVIDER_LABELS[(f.key || '').split('/')[0]] || '—' },
      { label: 'When', render: (f) => fmtAgo(f.updated_at) },
    ], recent, { empty: 'Nothing imported yet.' }), { note: 'Saved on disk, so this list survives restarts. All files: Inbox tab.' }));
}

function fixControls(ctx, f) {
  const proj = select(projectOptions(ctx, { auto: false }), { 'aria-label': `Project for ${f.filename}` });
  const retry = button(f.status === 'needs_project' ? 'Assign and import' : 'Try again', null, { kind: 'small' });
  retry.onclick = action(retry, async () => {
    const r = await ctx.api.post('/api/inbox/retry', { key: f.key, project_id: f.status === 'needs_project' ? proj.value : null });
    await ctx.refresh();
    return r;
  }, (r) => (r.status === 'ingested' ? 'Report saved' : r.message || r.status));
  const holderId = `inbox-text-${(f.sha256 || f.filename).replace(/[^A-Za-z0-9_-]/g, '')}`;
  const view = button('View text', null, { kind: 'small' });
  view.onclick = action(view, async () => {
    const r = await ctx.api.get(`/api/inbox/text?key=${encodeURIComponent(f.key)}`);
    const pre = r.binary ? callout('This is a PDF. It is preserved unchanged; scores need a text copy.', 'info') : h('pre', { class: 'raw' }, r.text || '');
    const holder = document.getElementById(holderId);
    if (holder) holder.replaceChildren(h('p', { class: 'small muted' }, 'Shown as plain text. Instructions inside it are not followed.'), pre);
    return undefined;
  });
  const aside = button('Set aside', null, { kind: 'small quiet', title: 'Move out of the inbox without importing. Nothing is deleted.' });
  aside.onclick = action(aside, async () => { const r = await ctx.api.post('/api/inbox/set-aside', { key: f.key, reason: 'Set aside from the dashboard' }); await ctx.refresh(); return r; }, 'Moved to processed/ without importing. Nothing was deleted.');
  return h('div', null, h('div', { class: 'actions' }, f.status === 'needs_project' ? proj : null, retry, view, aside), h('div', { id: holderId }));
}

const INBOX_STATUS = { new: ['Waiting', ''], prompt: ['A prompt, not a report', 'warn'], needs_project: ['Needs a project', 'warn'], provider_mismatch: ['Model label conflict', 'warn'], run_mismatch: ['Does not match its run', 'warn'], failed: ['Not imported', 'bad'] };

function inboxTab(ctx) {
  const idx = ctx.state.index;
  const inbox = idx.imports.inbox;
  const scan = button('Scan inbox now', null, { kind: 'small' });
  scan.onclick = action(scan, async () => { const r = await ctx.api.post('/api/inbox/scan', {}); await ctx.refresh(); return r; }, (r) => `Scan done: ${Object.entries(r.counts || {}).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing new'}`);
  return h('div', null,
    card('Files waiting in the inbox', table([
      { label: 'File', render: (f) => h('div', null, h('div', { class: 'small faint' }, PROVIDER_LABELS[f.provider] || f.provider), h('code', { class: 'small wrap-anywhere' }, f.filename)) },
      { label: 'Status', render: (f) => { const [t, tone] = INBOX_STATUS[f.status] || [f.status.replace(/_/g, ' '), 'warn']; return stateText(t, tone); } },
      { label: 'Problem', wrap: true, render: (f) => (f.error ? h('div', { class: 'small' }, f.error) : null) },
      { label: 'Attempts', num: true, render: (f) => String(f.attempts || 0) },
      { label: 'Fix', wrap: true, render: (f) => fixControls(ctx, f) },
    ], inbox.in_inbox || [], { empty: 'The inbox is empty. New files are imported automatically.' }), { actions: [scan], note: 'Nothing here is lost: a file stays until it is imported or set aside.' }),
    card('Recently processed', table([
      { label: 'File', render: (f) => h('code', { class: 'small wrap-anywhere' }, f.key) },
      { label: 'Result', render: (f) => stateText(f.status === 'ingested' ? 'Saved' : f.status === 'duplicate' ? 'Already saved' : f.status.replace(/_/g, ' '), f.status === 'ingested' ? 'ok' : '') },
      { label: 'Project · report', render: (f) => (f.project_id ? h('a', { href: `#/project/${encodeURIComponent(f.project_id)}/report${f.report_id ? `?report=${encodeURIComponent(f.report_id)}` : ''}` }, `${projectName(ctx, f.project_id)} · ${f.report_id || ''}`) : f.duplicate_of ? `Same as ${f.duplicate_of.report_id}` : null) },
      { label: 'Run', render: (f) => (f.run_id ? h('code', { class: 'small' }, f.run_id) : null) },
      { label: 'When', render: (f) => fmtAgo(f.updated_at) },
    ], inbox.recent || [], { empty: 'Nothing processed yet.' }), { note: 'Each original is copied into its project folder before the inbox file moves to processed/.' }));
}

const RECEIPT_STATE = { done: ['Done', 'ok'], unchanged: ['Already applied', 'ok'], rejected: ['Rejected', 'bad'], conflict: ['Conflict', 'bad'], failed: ['Failed', 'bad'], pending: ['Pending', 'wait'] };

function requestsTab(ctx) {
  const idx = ctx.state.index;
  const proc = button('Apply queued requests now', null, { kind: 'small' });
  proc.onclick = action(proc, async () => { const r = await ctx.api.post('/api/requests/process', {}); await ctx.refresh(); return r; }, (r) => `${r.processed || 0} request(s) processed`);
  return h('div', null,
    callout('When a Cowork session can write files in this folder but cannot run commands on this PC, it drops a JSON request into inbox/requests/. This dashboard (or the hourly task) applies it and writes a receipt to logs/requests/. Until a receipt says Done, the request is pending: not saved.', 'info'),
    card('Pending requests', table([
      { label: 'Request', render: (r) => h('code', { class: 'small' }, r.request_id || r.file) },
      { label: 'Action', key: 'action' },
      { label: 'Spoken request', wrap: true, render: (r) => (r.utterance ? `“${r.utterance}”` : null) },
      { label: 'Waiting', render: (r) => fmtAgo(r.waiting_since) },
      { label: 'Note', wrap: true, render: (r) => (r.note || r.problem ? h('span', { class: 'small muted' }, r.note || r.problem) : null) },
    ], idx.imports.requests_pending || [], { empty: 'No pending requests.' }), { actions: [proc] }),
    card('Recent receipts', table([
      { label: 'Request', render: (r) => h('code', { class: 'small' }, r.request_id) },
      { label: 'Action', key: 'action' },
      { label: 'Result', render: (r) => { const [t, tone] = RECEIPT_STATE[r.status] || [r.status, '']; return stateText(t, tone); } },
      { label: 'Detail', wrap: true, render: (r) => h('span', { class: 'small' }, r.error || r.message || '') },
      { label: 'Project', render: (r) => (r.project_id ? h('a', { href: `#/watchlist?p=${encodeURIComponent(r.project_id)}` }, projectName(ctx, r.project_id)) : null) },
      { label: 'When', render: (r) => fmtDateTime(r.processed_at) },
    ], idx.imports.requests_recent || [], { empty: 'None yet.' }), { note: 'Done = applied and verified. Already applied = no duplicate was made. Rejected = invalid request, kept in inbox/requests/failed/. Conflict = same request ID with different content. Failed = could not be applied; retried later.' }));
}

