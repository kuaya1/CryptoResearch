// Dialogs shared by the watchlist, the summary panel and the project page:
// Add project, Run research, Change sector. Every submission carries a
// one-time ID, so a double click or a retried request applies once; inputs
// stay in place after an error so they can be corrected and retried.
import {
  h, field, fieldError, input, select, button, callout, openDialog, submissionId, toast, copyText, busy, stateText, details,
  PROVIDERS, PROVIDER_LABELS, RESEARCH_STATE, fmtDateTime,
} from '../ui.js';
import { horizonHint, needsReason } from '../position-ui.js';

function money(v) {
  return typeof v === 'number' ? `$${v}` : 'not set';
}

// How each model would run right now, in words, with the next step.
function routeOf(ctx, prov) {
  const st = ((ctx.state.index.research || {}).providers || {})[prov] || { mode: 'manual' };
  if (st.mode === 'api') return { mode: 'api', text: `API · ${st.model} · paid, within your budget`, next: null };
  if (st.mode === 'mock') return { mode: 'mock', text: 'Demo · fictional answers; nothing is sent or billed', next: null };
  const who = PROVIDER_LABELS[prov];
  return {
    mode: 'manual',
    text: prov === 'claude' ? 'Manual · paste the prompt into Claude yourself, or ask Cowork to run it' : `Manual · paste the prompt into ${who}, then import its answer`,
    next: h('a', { href: '#/settings?tab=research', class: 'small' }, 'Set up API access'),
  };
}

function providerChoices(ctx, preselect) {
  const boxes = {};
  const group = h('fieldset', { class: 'choices', style: { border: 0, padding: 0, margin: 0 } },
    h('legend', { class: 'field-label', style: { marginBottom: '6px' } }, 'Models'),
    PROVIDERS.map((p) => {
      const r = routeOf(ctx, p);
      const cb = h('input', { type: 'checkbox', name: `provider-${p}`, checked: preselect.includes(p) });
      boxes[p] = cb;
      return h('label', { class: 'choice' }, cb, h('span', { class: 'title' }, PROVIDER_LABELS[p]), h('span', { class: 'desc' }, r.text, r.next ? h('span', null, ' · ', r.next) : null));
    }));
  return { group, chosen: () => PROVIDERS.filter((p) => boxes[p].checked) };
}

function costNote(ctx) {
  const r = ctx.state.index.research || {};
  const modes = Object.values(r.providers || {}).map((s) => s.mode);
  if (modes.length && modes.every((m) => m === 'mock')) return 'Demo workspace: every model answers with a fictional fixture. Nothing is sent anywhere and nothing is billed.';
  if (modes.includes('api')) return `API calls run only within your budget (per run ${money(r.budget.per_run_usd)}, day ${money(r.budget.daily_usd)}, month ${money(r.budget.monthly_usd)}). A request that has been sent cannot be un-sent; canceling stops retries, not charges already incurred.`;
  return 'No model API is set up, so nothing is billed. Each model gets the same prompt for you to paste; its job completes when you import the answer.';
}

// One row per model: its state in words and the next step.
export function researchReceipt(ctx, projectId, out) {
  if (!out) return null;
  const run = out.run || null;
  const jobs = run ? Object.values(run.jobs || {}) : [];
  const copyBtn = run ? button('Copy the research prompt', null, { kind: 'small' }) : null;
  if (copyBtn) {
    copyBtn.onclick = async () => {
      try {
        await copyText(await ctx.api.text(`/api/projects/${encodeURIComponent(projectId)}/research/${encodeURIComponent(run.run_id)}/prompt`));
      } catch (err) {
        toast(err.message, 'bad');
      }
    };
  }
  const manual = jobs.some((j) => j.mode === 'manual');
  return h('div', { class: 'receipt', role: 'status' },
    h('h3', null, out.status === 'created' ? 'Research requested' : out.status === 'exists' ? 'Already requested' : 'Research'),
    h('p', { class: 'small muted', style: { margin: '0 0 8px' } }, out.status === 'exists' ? out.message : 'Each model works independently. Pending means not saved yet; a report appears when it is saved.'),
    jobs.length ? h('ul', { class: 'rows' }, jobs.map((j) => {
      const key = j.state === 'unconfigured' ? 'manual' : j.state === 'running' && j.mode === 'cowork' ? 'cowork' : j.state;
      const st = RESEARCH_STATE[key] || { long: j.state, tone: '' };
      return h('li', null, h('span', { class: 'k' }, PROVIDER_LABELS[j.provider]),
        h('span', null, stateText(j.mode === 'mock' && key === 'queued' ? 'Queued: fictional demo answer' : st.long, st.tone)));
    })) : out.message ? h('p', { class: 'small' }, out.message) : null,
    run ? h('div', { class: 'btn-row' }, manual ? copyBtn : null,
      manual ? h('a', { class: 'btn small', href: `#/updates?tab=import&project=${encodeURIComponent(projectId)}&run=${encodeURIComponent(run.run_id)}` }, 'Import report for this run') : null) : null,
    run ? h('p', { class: 'small faint', style: { margin: '8px 0 0' } }, `Run ${run.run_id} · rubric ${run.rubric_version} · horizon ${run.horizon.text} · one prompt, identical for every model`) : null);
}

export function openResearchDialog(ctx, project, { providers = null } = {}) {
  const pid = project.project_id;
  const last = project.research && project.research.latest_run;
  const defaults = providers || (project.research_defaults && project.research_defaults.providers && project.research_defaults.providers.length ? project.research_defaults.providers : null) || ctx.state.index.settings.research.default_providers || PROVIDERS;
  const choices = providerChoices(ctx, defaults);
  const sameRadio = h('input', { type: 'radio', name: 'horizon-mode', value: 'same', checked: Boolean(last) });
  const customRadio = h('input', { type: 'radio', name: 'horizon-mode', value: 'custom', checked: !last });
  sameRadio.disabled = !last;
  const idx = ctx.state.index;
  const pol = idx.horizon_policy || { default_months: 4, planning_ceiling_months: 4 };
  // A position run's horizon is whole calendar months from today; the last
  // run's dates are re-anchored, never reused.
  const lastText = !last || !last.horizon ? '?' : last.horizon.recipe
    ? `${last.horizon.months} months from today${last.horizon.mode === 'long_term' ? ', long-term exception with the same reason' : ''}`
    : `${last.horizon.text} (from before the position recipe)`;
  const horizon = input({ name: 'horizon', value: `${pol.default_months} months` });
  const reason = input({ name: 'long_term_reason', placeholder: 'Why this project gets a longer horizon' });
  const reasonField = h('div', { class: 'horizon-reason', hidden: true }, field(pol.require_long_term_reason ? 'Long-term reason' : 'Long-term reason (optional)', reason, `${pol.require_long_term_reason ? 'Required' : 'Asked for'} above ${pol.planning_ceiling_months} months. It is saved with the run and shown in the prompt.`));
  const btn = button('Run research', null, { kind: 'primary', type: 'submit' });
  const errorBox = h('div', { role: 'alert' });
  const out = h('div');
  const sid = submissionId();
  const form = h('form', { class: 'form-stack' },
    choices.group,
    h('fieldset', { class: 'choices', style: { border: 0, padding: 0, margin: 0 } }, h('legend', { class: 'field-label', style: { marginBottom: '6px' } }, 'Horizon and rubric'),
      h('label', { class: 'choice' }, sameRadio, h('span', { class: 'title' }, 'Same as the last run'), h('span', { class: 'desc' }, last ? `${lastText}, with the same rubric version` : 'No earlier run for this project')),
      h('label', { class: 'choice' }, customRadio, h('span', { class: 'title' }, 'Choose a horizon'), h('span', { class: 'desc' }, 'Uses the current rubric version'))),
    field('Horizon', horizon, horizonHint(idx)),
    reasonField,
    callout(costNote(ctx), 'info'),
    errorBox,
    h('div', { class: 'dlg-foot' }, btn));
  const syncHorizon = () => {
    horizon.disabled = sameRadio.checked;
    reasonField.hidden = sameRadio.checked || !needsReason(idx, horizon.value);
  };
  sameRadio.onchange = syncHorizon;
  customRadio.onchange = syncHorizon;
  horizon.addEventListener('input', syncHorizon);
  syncHorizon();
  form.onsubmit = async (e) => {
    e.preventDefault();
    errorBox.replaceChildren();
    const chosen = choices.chosen();
    if (!chosen.length) {
      errorBox.replaceChildren(callout('Choose at least one model.', 'bad'));
      return;
    }
    if (!sameRadio.checked && !horizon.value.trim()) return fieldError(horizon, `Type a horizon, for example "${pol.default_months} months".`);
    const longTerm = !sameRadio.checked && needsReason(idx, horizon.value);
    if (longTerm && pol.require_long_term_reason && !reason.value.trim()) return fieldError(reason, `A horizon above ${pol.planning_ceiling_months} months is a long-term exception: say why.`);
    busy(btn, true, 'Requesting…');
    try {
      const r = await ctx.api.post(`/api/projects/${encodeURIComponent(pid)}/research`, { providers: chosen, horizon: sameRadio.checked ? null : horizon.value.trim(), long_term_reason: longTerm ? reason.value.trim() : null, same_as_last: sameRadio.checked, submission_id: sid });
      form.classList.add('hidden');
      out.replaceChildren(researchReceipt(ctx, pid, r), h('div', { class: 'dlg-foot' }, button('Done', () => dlgApi.close(), { kind: 'primary' })));
      await ctx.refresh();
    } catch (err) {
      busy(btn, false);
      errorBox.replaceChildren(callout(`Not requested: ${err.message}. Your choices are kept; you can try again.`, 'bad'));
    }
  };
  const dlgApi = openDialog(`Run research: ${project.name}`, h('div', null, form, out));
}

export function openSectorDialog(ctx, project) {
  const sectors = ctx.state.index.sectors || [];
  const cur = project.sector || {};
  const sel = select(sectors.map((s) => ({ value: s.id, label: s.label, selected: s.id === cur.primary })));
  const tags = input({ value: (cur.tags || []).join(', '), placeholder: 'e.g. lending, RWA' });
  const btn = button('Save sector', null, { kind: 'primary', type: 'submit' });
  const errorBox = h('div', { role: 'alert' });
  const form = h('form', { class: 'form-stack' },
    field('Primary sector', sel, 'Used for filters and portfolio concentration.'),
    field('Tags', tags, 'Optional, comma-separated.'),
    callout(`The sector is your label. It does not change how reports are graded: each report is scored with the profile and rubric it declares (this project's profile is ${project.sector_profile}).`, 'info'),
    errorBox,
    h('div', { class: 'dlg-foot' }, btn));
  const dlg = openDialog(`Sector: ${project.name}`, form);
  form.onsubmit = async (e) => {
    e.preventDefault();
    busy(btn, true, 'Saving…');
    try {
      await ctx.api.post(`/api/projects/${encodeURIComponent(project.project_id)}/fields`, { sector: { primary: sel.value, tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean) } });
      toast('Sector saved');
      dlg.close();
      await ctx.refresh();
    } catch (err) {
      busy(btn, false);
      errorBox.replaceChildren(callout(`Not saved: ${err.message}`, 'bad'));
    }
  };
}

// ---- Add project: name or URL first, details only when needed -------------

function parseQuery(text) {
  const t = text.trim();
  const looksUrl = /^https?:\/\//i.test(t) || (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(t) && !/\s/.test(t));
  if (!looksUrl) return { name: t, website: null, search: t };
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
  } catch (_) {
    return { name: t, website: null, search: t };
  }
  const host = url.hostname.replace(/^www\./, '');
  const stem = host.split('.')[0];
  const guess = stem.charAt(0).toUpperCase() + stem.slice(1);
  return { name: guess, website: url.toString(), search: stem };
}

export function openAddProjectDialog(ctx) {
  const st = { query: '', parsed: null, lookup: null, picked: null, sid: submissionId() };
  const body = h('div');
  const dlg = openDialog('Add project', body);
  renderFind();

  function renderFind() {
    const q = input({ placeholder: 'e.g. Allora Network or https://www.allora.network', autocomplete: 'off', value: st.query });
    const go = button('Continue', null, { kind: 'primary', type: 'submit' });
    const form = h('form', { class: 'form-stack' },
      field('Project name or official website', q, 'Next you can pick its market listing. Nothing is saved until you choose Add project.'),
      h('div', { class: 'dlg-foot' }, button('Cancel', () => dlg.close()), go));
    form.onsubmit = async (e) => {
      e.preventDefault();
      const text = q.value.trim();
      if (!text) return fieldError(q, 'Type a project name or its official website.');
      fieldError(q, null);
      st.query = text;
      st.parsed = parseQuery(text);
      busy(go, true, 'Searching…');
      try {
        st.lookup = await ctx.api.get(`/api/market/lookup?q=${encodeURIComponent(st.parsed.search)}`);
      } catch (err) {
        st.lookup = { status: 'failed', message: err.message, candidates: [] };
      }
      st.picked = st.lookup.candidates && st.lookup.candidates.length === 1 && !st.lookup.ambiguous ? st.lookup.candidates[0].coingecko_id : null;
      renderDetails();
    };
    body.replaceChildren(form);
    q.focus();
  }

  function renderDetails() {
    const lk = st.lookup || { candidates: [] };
    const cands = lk.candidates || [];
    const picked = () => cands.find((c) => c.coingecko_id === st.picked) || null;
    const name = input({ value: (picked() && picked().name) || st.parsed.name, autocomplete: 'off' });
    const website = input({ type: 'url', value: st.parsed.website || '', placeholder: 'https://' });
    const sector = select([{ value: '', label: 'Choose later' }, ...(ctx.state.index.sectors || []).map((s) => ({ value: s.id, label: s.label }))]);
    const confirm = h('input', { type: 'checkbox', name: 'confirmed' });
    const symbol = input({ value: (picked() && picked().symbol) || '', placeholder: 'optional' });
    const chain = input({ placeholder: 'e.g. ethereum, solana' });
    const contract = input({ placeholder: 'contract or mint address' });
    const evidence = input({ type: 'url', placeholder: 'official page that names the token' });
    const research = h('input', { type: 'checkbox', name: 'research-now' });
    const choices = providerChoices(ctx, ctx.state.index.settings.research.default_providers || PROVIDERS);
    const researchBox = h('div', { class: 'form-stack hidden' }, choices.group, callout(costNote(ctx), 'info'));
    research.onchange = () => researchBox.classList.toggle('hidden', !research.checked);
    const outcome = h('p', { class: 'small', 'aria-live': 'polite', style: { margin: 0 } });
    const confirmRow = h('label', { class: 'check' }, confirm, h('span', null, 'I checked that the official website links to this listing'));
    const updateOutcome = () => {
      const c = picked();
      confirmRow.classList.toggle('hidden', !c);
      // Mirrors the save rule: official website + a token binding + evidence.
      const bound = Boolean(c) || Boolean(chain.value.trim() && contract.value.trim());
      const verified = Boolean(bound && website.value.trim() && ((c && confirm.checked) || evidence.value.trim()));
      outcome.replaceChildren(verified
        ? stateText('Identity will be verified: prices load within minutes', 'ok')
        : stateText(c ? 'Identity stays pending until you confirm the listing on the official website (no prices until then)' : 'Saved with a pending identity: no prices until a market listing is confirmed', 'warn'));
      if (c && !symbol.value) symbol.value = c.symbol || '';
    };
    const radios = h('div', { class: 'choices', role: 'radiogroup', 'aria-label': 'Market listing' },
      cands.map((c) => h('label', { class: 'choice' },
        h('input', { type: 'radio', name: 'listing', value: c.coingecko_id, checked: st.picked === c.coingecko_id, onchange: () => { st.picked = c.coingecko_id; if (!name.dataset.touched) name.value = c.name || name.value; updateOutcome(); } }),
        h('span', { class: 'title' }, `${c.name || c.coingecko_id}${c.symbol ? ` (${c.symbol})` : ''}`),
        h('span', { class: 'desc' }, `${c.market_cap_rank ? `CoinGecko rank #${c.market_cap_rank}` : 'Unranked on CoinGecko'} · listing ID ${c.coingecko_id}`))),
      h('label', { class: 'choice' },
        h('input', { type: 'radio', name: 'listing', value: '', checked: !st.picked, onchange: () => { st.picked = null; updateOutcome(); } }),
        h('span', { class: 'title' }, cands.length ? 'None of these, or not listed yet' : 'Not listed'),
        h('span', { class: 'desc' }, 'Saved with a pending identity. No prices until a listing is confirmed.')));
    name.addEventListener('input', () => { name.dataset.touched = '1'; });
    for (const el of [website, evidence, confirm, chain, contract]) el.addEventListener('input', updateOutcome);
    confirm.addEventListener('change', updateOutcome);
    const add = button('Add project', null, { kind: 'primary', type: 'submit' });
    const errorBox = h('div', { role: 'alert' });
    const lookupNote = lk.status === 'failed' || lk.status === 'backoff' || lk.status === 'budget_paused'
      ? callout(`Couldn't search the market listings: ${lk.message} You can still add the project; its identity stays pending until a listing is confirmed.`, 'warn')
      : !cands.length ? callout(`No CoinGecko listing found for “${st.parsed.search}”. You can add it with a pending identity and confirm a listing later.`, 'info')
        : lk.ambiguous ? callout('Several listings share this ticker. Pick the one the project\'s official website links to.', 'warn')
          : cands.length > 1 ? callout(` possible listings. Pick the one the project's official website links to, or choose None of these.`, 'info') : null;
    const form = h('form', { class: 'form-stack' },
      h('div', null, h('div', { class: 'field-label' }, `Market listing for “${st.query}”`), lookupNote, radios),
      field('Name', name),
      field('Official website', website, 'Used to confirm the listing and shown on the project page.'),
      confirmRow,
      field('Sector', sector, 'Your label for filters. You can change it later.'),
      outcome,
      details('More identity details (optional)', h('div', { class: 'form-grid' },
        field('Ticker', symbol), field('Chain', chain), field('Contract or mint', contract),
        field('Official page that names the token', evidence, 'Recorded as identity evidence.', { wide: true }))),
      h('div', { class: 'form-stack' }, h('label', { class: 'check' }, research, h('span', null, 'Run research after saving')), researchBox),
      h('p', { class: 'small muted', style: { margin: 0 } }, 'Adding a project never records a holding. Repeating this form does not create a duplicate.'),
      errorBox,
      h('div', { class: 'dlg-foot' }, button('Back', () => renderFind()), add));
    updateOutcome();
    form.onsubmit = async (e) => {
      e.preventDefault();
      errorBox.replaceChildren();
      if (!name.value.trim()) return fieldError(name, 'A project name is required.');
      fieldError(name, null);
      if (research.checked && !choices.chosen().length) {
        errorBox.replaceChildren(callout('Choose at least one model, or turn off "Run research after saving".', 'bad'));
        return;
      }
      const c = picked();
      const evidenceList = [];
      if (evidence.value.trim()) evidenceList.push({ url: evidence.value.trim(), note: 'Official page that names the token (added in the dashboard)', kind: 'user' });
      if (c && confirm.checked && website.value.trim()) evidenceList.push({ url: website.value.trim(), note: `You confirmed this official website links to the CoinGecko listing ${c.coingecko_id}`, kind: 'owner_confirmed' });
      const payload = {
        name: name.value.trim(),
        symbol: symbol.value.trim() || null,
        official_website: website.value.trim() || null,
        coingecko_id: c ? c.coingecko_id : null,
        assets: chain.value.trim() ? [{ chain: chain.value.trim(), contract_address: contract.value.trim() || null }] : [],
        evidence: evidenceList,
        sector: sector.value || null,
        research: research.checked,
        research_providers: research.checked ? choices.chosen() : [],
        horizon: research.checked ? `${(ctx.state.index.horizon_policy || {}).default_months || 4} months` : null,
        submission_id: st.sid,
      };
      busy(add, true, 'Saving…');
      try {
        const r = await ctx.api.post('/api/projects', payload);
        if (r.status === 'possible_duplicate') {
          busy(add, false);
          errorBox.replaceChildren(h('div', { class: 'callout warn' },
            h('p', { style: { margin: '0 0 6px' } }, h('strong', null, 'Not saved yet: '), r.message),
            h('ul', { class: 'list' }, (r.candidates || []).map((x) => h('li', null, h('a', { href: `#/watchlist?p=${encodeURIComponent(x.project_id)}`, onclick: () => dlg.close() }, x.project_id), ` (${(x.reasons || []).join(', ')})`))),
            button('It is a different project: add it anyway', async () => {
              st.sid = submissionId();
              try {
                const again = await ctx.api.post('/api/projects', { ...payload, allow_same_symbol: true, submission_id: st.sid });
                renderReceipt(again, payload);
                await ctx.refresh();
              } catch (err2) {
                errorBox.replaceChildren(callout(`Not saved: ${err2.message}`, 'bad'));
              }
            }, { kind: 'small' })));
          return;
        }
        renderReceipt(r, payload);
        await ctx.refresh();
      } catch (err) {
        busy(add, false);
        errorBox.replaceChildren(callout(`Not saved: ${err.message}${err.saved === 'unknown' ? ' It is unclear whether anything was written; repeating this same form is safe.' : ' Your entries are kept; you can correct them and try again.'}`, 'bad'));
      }
    };
    body.replaceChildren(form);
    const first = form.querySelector('input[name="listing"]:checked') || name;
    first.focus();
  }

  function renderReceipt(r, payload) {
    const pid = r.project_id;
    const verified = r.identity_status === 'verified';
    const rows = [
      ['Project', h('span', null, h('strong', null, payload.name), r.status === 'exists' ? ' was already in your workspace; nothing was duplicated.' : ' is saved in your workspace.')],
      ['Identity', verified ? stateText('Verified: prices load within minutes', 'ok') : stateText('Pending: no prices until a market listing is confirmed (Project → Research runs → Token identity)', 'warn')],
      ['Research', r.research ? h('span', null, r.research.message || r.research.status) : h('span', { class: 'muted' }, 'Not requested. Use Run research any time.')],
      ['Holdings', h('span', { class: 'muted' }, 'None created. The watchlist never records holdings.')],
    ];
    const close = () => dlg.close();
    body.replaceChildren(h('div', { class: 'receipt', role: 'status' },
      h('h3', null, r.status === 'exists' ? 'Already saved' : 'Saved'),
      h('ul', { class: 'rows' }, rows.map(([k, v]) => h('li', null, h('span', { class: 'k' }, k), v))),
      h('p', { class: 'small faint', style: { margin: '8px 0 0' } }, `Saved ${fmtDateTime(new Date().toISOString())} · projects/${pid}/`),
      h('div', { class: 'btn-row' },
        h('a', { class: 'btn primary', href: `#/watchlist?p=${encodeURIComponent(pid)}`, onclick: close }, 'Show in watchlist'),
        h('a', { class: 'btn', href: `#/project/${encodeURIComponent(pid)}/overview`, onclick: close }, 'Open project'),
        button('Add another', () => { st.query = ''; st.parsed = null; st.lookup = null; st.picked = null; st.sid = submissionId(); renderFind(); }, { kind: 'quiet' }))));
    body.querySelector('.receipt a').focus();
  }
}
