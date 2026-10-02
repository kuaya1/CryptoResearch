// New research: the one place to start research, made for the phone.
//
// Paste a CoinMarketCap link (or type a name) and/or add a screenshot, add
// optional instructions, and send. The request is saved first, then the
// project is identified in the background. Research starts only after you
// confirm one candidate, with its network, contract and website in view.
// Progress, cost and the saved report then follow from the research run.
// Leaving the page loses nothing: requests are records, listed below the form.
import { h, clear, card, field, input, select, button, callout, chip, stateText, kv, fmtUsd, fmtDateTime, fmtAgo, toast, busy, submissionId, empty, details, announce } from '../ui.js';

const SECTORS = [['defi', 'DeFi'], ['payments', 'Payments / PayFi'], ['infrastructure', 'Infrastructure'], ['ai_data', 'AI / Data'], ['gaming', 'Gaming'], ['other', 'Other']];
const STATUS = {
  identifying: ['Identifying the project', 'wait'],
  needs_confirmation: ['Waiting for your confirmation', 'warn'],
  identity_failed: ['Not identified', 'bad'],
  researching: ['Research in progress', 'wait'],
  done: ['Report saved', 'ok'],
  failed: ['Research failed', 'bad'],
  canceled: ['Dismissed', ''],
};
const JOB = {
  queued: ['Waiting to start', 'wait'],
  dispatching: ['Claude is researching', 'wait'],
  running: ['Claude is researching', 'wait'],
  uncertain: ['Outcome uncertain: check before retrying', 'warn'],
  unconfigured: ['Waiting: automatic research is not set up', 'warn'],
  completed: ['Report saved', 'ok'],
  failed: ['Failed: no report was saved', 'bad'],
  canceled: ['Canceled', ''],
};
const POLL_MS = 3000;
const MAX_UPLOAD = 4.5 * 1024 * 1024;
const view = { timer: null, seq: 0, shots: new Map() };

// Images the page itself read (FileReader) or fetched with the session token.
// They are data: URLs, which the shared link check rightly refuses for links.
function dataImg(dataUrl, attrs) {
  const img = h('img', attrs);
  if (typeof dataUrl === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) img.src = dataUrl;
  return img;
}

const short = (s, n = 10) => (typeof s === 'string' && s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-6)}` : s || '');
const titleOf = (d) => (d.confirmed ? `${d.confirmed.name}${d.confirmed.symbol ? ` (${d.confirmed.symbol})` : ''}` : d.identity && d.identity.candidates && d.identity.candidates.length === 1 ? d.identity.candidates[0].name : d.input.parsed && d.input.parsed.query ? d.input.parsed.query : d.input.link || (d.input.screenshot ? 'Screenshot' : 'Research request'));

function stopPolling() {
  clearTimeout(view.timer);
  view.timer = null;
}

export async function renderIntake(ctx, route) {
  stopPolling();
  const seq = ++view.seq;
  const id = route.args[0] || null;
  return id ? renderRequest(ctx, id, seq) : renderStart(ctx);
}

// ---------------------------------------------------------------------------
// Desk status: is automatic research ready, and what has been spent

function deskLine(desk) {
  const b = desk.budget || {};
  const s = desk.spend || {};
  const limits = typeof b.per_run_usd === 'number'
    ? `Limits: ${fmtUsd(b.per_run_usd)} per run, ${fmtUsd(b.daily_usd)} per day (${fmtUsd(s.daily || 0)} used today), ${fmtUsd(b.monthly_usd)} per month (${fmtUsd(s.monthly || 0)} used this month).`
    : 'No spending limits are set, so no paid call is made.';
  if (desk.claude.mode === 'api') {
    return callout(h('span', null, h('strong', null, 'Automatic research is on. '), `Claude (${desk.claude.model}) researches each confirmed project with web search and saves the report. ${limits}`), 'ok');
  }
  if (desk.claude.mode === 'mock') {
    return callout(h('span', null, h('strong', null, 'Fictional research (test or demo workspace). '), 'Confirmed projects get a fictional fixture report, not Claude. Nothing is paid for.'), 'info');
  }
  const missing = (desk.claude.missing || []).join(', ') || desk.claude.reason || 'not configured';
  return callout(h('span', null, h('strong', null, 'Automatic research is not set up yet '), `(missing: ${missing}). Requests are still saved and identified; research then waits with a ready-to-paste prompt. ${limits}`), 'warn');
}

// ---------------------------------------------------------------------------
// The form and the recent requests

async function readImage(file) {
  if (!file) return null;
  if (!/^image\//.test(file.type)) throw new Error('Choose an image file (a screenshot).');
  // Large or unusual images are redrawn as a JPEG no wider than 2000 px, which
  // keeps the upload small; Claude reads screenshots at about that size anyway.
  let blob = file;
  let type = file.type;
  const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  if (file.size > MAX_UPLOAD || !allowed.includes(file.type)) {
    if (typeof createImageBitmap !== 'function') throw new Error('This screenshot is too large or in an unusual format. Use a PNG or JPEG under 4.5 MB.');
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    type = 'image/jpeg';
    if (!blob || blob.size > MAX_UPLOAD) throw new Error('The screenshot is still too large after resizing. Crop it and try again.');
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('The screenshot could not be read.'));
    r.readAsDataURL(blob);
  });
  return { media_type: type, data_base64: dataUrl.slice(dataUrl.indexOf(',') + 1), preview: dataUrl };
}

async function renderStart(ctx) {
  let data;
  try {
    data = await ctx.api.get('/api/intake');
  } catch (err) {
    return h('div', null, h('h1', null, 'New research'), callout(`Could not load research requests: ${err.message}`, 'bad'));
  }
  const linkIn = input({ name: 'intake-link', placeholder: 'coinmarketcap.com/currencies/…  or a project name', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', inputmode: 'url', enterkeyhint: 'next' });
  const fileIn = h('input', { type: 'file', name: 'intake-shot', accept: 'image/png,image/jpeg,image/webp,image/gif,image/*' });
  const preview = h('div', { class: 'intake-preview hidden' });
  const note = h('textarea', { name: 'intake-instructions', rows: 4, maxlength: 2000, placeholder: 'Optional: what you want looked into, e.g. "Who actually uses it? Is the March unlock a risk inside four months?"' });
  const sendBtn = button('Find this project', null, { kind: 'primary', type: 'submit', key: 'intake-send' });
  const reservation = data.desk.screenshot_reservation_usd;
  let image = null;
  fileIn.addEventListener('change', async () => {
    image = null;
    clear(preview).classList.add('hidden');
    const f = fileIn.files && fileIn.files[0];
    if (!f) return;
    try {
      image = await readImage(f);
      preview.append(dataImg(image.preview, { alt: 'Screenshot to identify' }), button('Remove', () => { fileIn.value = ''; image = null; clear(preview).classList.add('hidden'); }, { kind: 'small quiet' }));
      preview.classList.remove('hidden');
    } catch (err) {
      fileIn.value = '';
      toast(err.message, 'bad');
    }
  });
  const form = h('form', { class: 'intake-form', dataset: { key: 'intake-form' }, onsubmit: async (e) => {
    e.preventDefault();
    if (sendBtn.getAttribute('aria-busy') === 'true') return;
    const link = linkIn.value.trim();
    if (!link && !image) {
      toast('Paste a CoinMarketCap link, type a project name, or add a screenshot.', 'bad');
      linkIn.focus();
      return;
    }
    busy(sendBtn, true, 'Saving…');
    try {
      const out = await ctx.api.post('/api/intake', { submission_id: form.dataset.sid, link: link || null, instructions: note.value.trim() || null, screenshot: image ? { media_type: image.media_type, data_base64: image.data_base64 } : null });
      if (out.status === 'exists') toast(out.message);
      form.dataset.sid = submissionId();
      linkIn.value = '';
      note.value = '';
      fileIn.value = '';
      image = null;
      ctx.navigate(`#/new/${encodeURIComponent(out.intake.intake_id)}`);
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      if (sendBtn.isConnected) busy(sendBtn, false);
    }
  } },
  field('CoinMarketCap link or project name', linkIn, 'A coinmarketcap.com/currencies/… or coingecko.com/en/coins/… link works best. The page itself is never opened: only the name or contract in the link is used.', { wide: true }),
  field('Screenshot (optional)', fileIn, `A CoinMarketCap, exchange or wallet screenshot. Claude reads only what is visible${typeof reservation === 'number' ? ` (one small paid call, at most ${fmtUsd(reservation)})` : ''}. A screenshot never records a holding.`, { wide: true }),
  preview,
  field('Instructions (optional)', note, 'Your questions for this research. Claude treats them as questions to look into, never as conclusions.', { wide: true }),
  h('div', { class: 'btn-row' }, sendBtn, h('span', { class: 'small muted' }, 'Nothing is researched or paid for until you confirm the project.')));
  form.dataset.sid = submissionId();

  const list = data.intakes.filter((d) => !d.broken);
  const rows = list.length ? h('ul', { class: 'intake-list' }, list.map((d) => {
    const [label, tone] = STATUS[d.status] || [d.status, ''];
    const rs = d.research && d.research.state ? JOB[d.research.state] : null;
    return h('li', null, h('a', { href: `#/new/${encodeURIComponent(d.intake_id)}`, dataset: { key: `intake-${d.intake_id}` } },
      h('span', { class: 'intake-name' }, titleOf(d)),
      h('span', { class: 'intake-meta' }, stateText(d.status === 'researching' && rs ? rs[0] : label, d.status === 'researching' && rs ? rs[1] : tone), h('span', { class: 'faint' }, fmtAgo(d.created_at)))));
  })) : empty('No research requests yet.');

  return h('div', { class: 'intake-page' },
    h('h1', null, 'New research'),
    deskLine(data.desk),
    card('Research a project', form),
    card('Recent requests', rows, { note: 'Each request keeps its own progress. Open one to confirm the project or follow the research.' }));
}

// ---------------------------------------------------------------------------
// One request: what was sent, the candidates, the research progress

async function screenshotFor(ctx, id) {
  const res = await fetch(`/api/intake/${encodeURIComponent(id)}/screenshot`, { headers: { 'x-cr-token': ctx.state.token } });
  if (!res.ok) return null;
  const blob = await res.blob();
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
}

function candidateCard(ctx, d, c, rerun) {
  const sector = select(SECTORS.map(([v, l]) => ({ value: v, label: l, selected: v === c.sector_guess })), { name: `sector-${c.coingecko_id}`, 'aria-label': `Sector for ${c.name}` });
  const msg = h('div');
  const go = button(`Research ${c.name}`, null, { kind: 'primary', key: `confirm-${c.coingecko_id}` });
  const confirm = async (different) => {
    if (go.getAttribute('aria-busy') === 'true') return;
    busy(go, true, 'Starting…');
    clear(msg);
    try {
      await ctx.api.post(`/api/intake/${encodeURIComponent(d.intake_id)}/confirm`, { coingecko_id: c.coingecko_id, sector: sector.value, different_project: different });
      announce(`${c.name} confirmed. Research started.`);
      await rerun();
    } catch (err) {
      if (err.code === 'AMBIGUOUS') {
        msg.append(callout(err.message, 'warn'), h('div', { class: 'btn-row' }, button('This is a different project: research it', () => confirm(true), { key: `confirm-diff-${c.coingecko_id}` })));
      } else msg.append(callout(err.message, 'bad'));
    } finally {
      if (go.isConnected) busy(go, false);
    }
  };
  go.addEventListener('click', () => confirm(false));
  const nets = c.platforms && c.platforms.length
    ? h('ul', { class: 'intake-nets' }, c.platforms.map((p) => h('li', null, h('span', { class: 'net' }, p.chain), ' ', h('code', { title: p.address }, short(p.address)))))
    : h('span', null, 'Its own network (no token contract listed)');
  return h('div', { class: 'intake-cand' },
    h('div', { class: 'intake-cand-head' }, h('h3', null, c.name, c.symbol ? h('span', { class: 'muted' }, ` ${c.symbol}`) : null), c.market_cap_rank ? chip(`Rank #${c.market_cap_rank}`, 'info', 'CoinGecko market-cap rank') : chip('Unranked', '', 'No CoinGecko market-cap rank')),
    kv([
      ['Website', c.homepage ? h('a', { href: c.homepage }, c.homepage.replace(/^https?:\/\//, '').replace(/\/$/, '')) : h('span', { class: 'warn-text' }, 'None listed: the identity stays unconfirmed until a website is added')],
      ['Network and contract', nets],
      ['Listing', h('a', { href: c.coingecko_url }, 'CoinGecko')],
      ['Why it matched', (c.reasons || []).join(' ')],
      ['Sector', sector],
    ]),
    h('div', { class: 'btn-row' }, go),
    msg);
}

function progressBlock(ctx, d, rerun) {
  const r = d.research;
  if (!r) return null;
  if (r.state === 'missing') return callout(r.message, 'bad');
  const [label, tone] = JOB[r.state] || [r.state, ''];
  const parts = [h('p', { class: 'intake-state' }, stateText(label, tone))];
  if (['queued', 'dispatching', 'running'].includes(r.state)) {
    parts.push(h('p', { class: 'muted' }, 'Claude researches with web search and writes the full report; this usually takes 3 to 10 minutes. You can leave this page or close the browser: the report is saved and shown on the project page automatically.'));
  } else if (r.state === 'unconfigured') {
    parts.push(callout(`${r.note || 'The Claude API is not set up.'} The research prompt is ready: open the project page to copy it into Claude yourself and import the answer there.`, 'warn'));
  } else if (r.state === 'uncertain') {
    parts.push(callout(`${r.error || 'The request may have reached Anthropic and been billed, and no answer was saved.'} It is never resent by itself. Check the Anthropic Console usage page, then record the charge on the project page, or retry (a retry is a new paid attempt).`, 'warn'));
  } else if (r.state === 'failed') {
    parts.push(callout(r.error || 'No report was saved.', 'bad'));
  } else if (r.state === 'completed') {
    parts.push(callout(h('span', null, 'The report is saved and shown on the project page. ', h('a', { href: `#/project/${encodeURIComponent(r.project_id)}` }, 'Open the project')), 'ok'));
  }
  const c = r.cost || {};
  parts.push(kv([
    ['Project', h('a', { href: `#/project/${encodeURIComponent(r.project_id)}` }, d.confirmed ? d.confirmed.name : r.project_id)],
    ['Model', r.model || '—'],
    ['Attempts', r.max_attempts ? `${r.attempts} of at most ${r.max_attempts}` : String(r.attempts)],
    ['Started', r.started_at ? fmtDateTime(r.started_at) : '—'],
    ['Finished', r.finished_at ? fmtDateTime(r.finished_at) : '—'],
    ['Horizon', r.horizon && r.horizon_window && !r.horizon.includes(r.horizon_window) ? `${r.horizon} (${r.horizon_window})` : r.horizon],
    ['Cost', r.mode === 'mock' ? 'Fictional fixture: nothing was sent or billed' : r.attempts ? h('span', null, c.all_recorded ? `${fmtUsd(c.recorded_usd)} recorded (Anthropic's reported usage)` : `${fmtUsd(c.counted_usd)} counted so far (the reservation, until the actual cost is known)`, h('span', { class: 'note-line' }, `Reserved before sending: ${fmtUsd(c.reserved_usd)}`)) : 'Nothing sent yet'],
    d.screenshot_cost_usd !== null && d.screenshot_cost_usd !== undefined ? ['Screenshot read', fmtUsd(d.screenshot_cost_usd)] : null,
    ['Your instructions', r.instructions ? h('span', { class: 'pre' }, r.instructions) : 'None'],
  ]));
  const actions = [];
  if (['failed', 'uncertain'].includes(r.state)) {
    const retry = button('Retry research', null, { kind: r.state === 'failed' ? 'primary' : '', key: 'intake-retry-research' });
    retry.addEventListener('click', async () => {
      if (r.state === 'uncertain' && !window.confirm('The earlier attempt may already have been billed. Send a new paid attempt anyway?')) return;
      busy(retry, true, 'Queuing…');
      try {
        const out = await ctx.api.post(`/api/intake/${encodeURIComponent(d.intake_id)}/retry-research`, {});
        toast(out.message || 'Queued again.');
        await rerun();
      } catch (err) {
        toast(err.message, 'bad');
      } finally {
        if (retry.isConnected) busy(retry, false);
      }
    });
    actions.push(retry);
  }
  if (actions.length) parts.push(h('div', { class: 'btn-row' }, actions));
  return card('Research', parts);
}

async function renderRequest(ctx, id, seq) {
  const page = h('div', { class: 'intake-page' });
  const body = h('div');
  let shot = view.shots.has(id) ? view.shots.get(id) : null;
  const draw = (out) => {
    const d = out.intake;
    clear(body);
    const [label, tone] = STATUS[d.status] || [d.status, ''];
    body.append(h('h1', null, titleOf(d)), h('p', { class: 'intake-state' }, stateText(label, tone)), h('p', { class: 'small faint intake-sent' }, `Sent ${fmtDateTime(d.created_at)}`));
    if (d.status === 'needs_confirmation' || d.status === 'identity_failed' || d.status === 'identifying') body.append(deskLine(out.desk));
    // What was sent.
    const sent = [];
    if (d.input.link) sent.push(['Link or name', d.input.link]);
    if (d.input.link_problem) sent.push(['Link', h('span', { class: 'warn-text' }, d.input.link_problem)]);
    if (d.input.screenshot) sent.push(['Screenshot', shot ? dataImg(shot, { class: 'intake-shot', alt: 'The screenshot you sent' }) : 'Attached']);
    const sr = d.identity && d.identity.screenshot_read;
    if (sr && sr.phase === 'read' && sr.fields) sent.push(['Claude read', `${sr.fields.project_name || 'no name visible'}${sr.fields.symbol ? ` (${sr.fields.symbol})` : ''}${sr.fields.chain ? `, ${sr.fields.chain}` : ''}${sr.fields.contract_address ? `, contract ${short(sr.fields.contract_address)}` : ''} · confidence ${sr.fields.confidence}`]);
    sent.push(['Your instructions', d.input.instructions ? h('span', { class: 'pre' }, d.input.instructions) : 'None']);
    body.append(card('What you sent', kv(sent)));

    if (d.status === 'identifying') {
      body.append(card('Identifying', h('p', { class: 'muted' }, d.input.screenshot ? 'Reading the screenshot and looking the project up on CoinGecko…' : 'Looking the project up on CoinGecko…')));
    } else if (d.status === 'needs_confirmation') {
      const idn = d.identity;
      const cands = idn.candidates || [];
      const head = [];
      if (idn.ambiguous) head.push(callout('These candidates look alike (close match or the same ticker). Check the website, network and contract before choosing: research starts only for the one you pick.', 'warn'));
      for (const n of idn.notes || []) head.push(callout(n, 'info'));
      const dismiss = button('None of these', null, { kind: 'quiet', key: 'intake-dismiss' });
      dismiss.addEventListener('click', async () => {
        busy(dismiss, true, 'Dismissing…');
        try {
          await ctx.api.post(`/api/intake/${encodeURIComponent(d.intake_id)}/dismiss`, {});
          ctx.navigate('#/new');
        } catch (err) {
          toast(err.message, 'bad');
          if (dismiss.isConnected) busy(dismiss, false);
        }
      });
      body.append(card(cands.length === 1 ? 'Is this the project?' : 'Which project do you mean?', [head, cands.map((c) => candidateCard(ctx, d, c, load)), h('div', { class: 'btn-row' }, dismiss, h('span', { class: 'small muted' }, 'Not listed? Send a new request with its CoinMarketCap link or contract.'))], { note: 'From CoinGecko\'s listing. Confirming adds it to your watchlist and starts one Claude research run.' }));
    } else if (d.status === 'identity_failed') {
      const idn = d.identity || {};
      const retry = button('Try again', null, { kind: 'primary', key: 'intake-retry-identity' });
      retry.addEventListener('click', async () => {
        busy(retry, true, 'Starting…');
        try {
          await ctx.api.post(`/api/intake/${encodeURIComponent(d.intake_id)}/retry-identity`, {});
          await load();
        } catch (err) {
          toast(err.message, 'bad');
          if (retry.isConnected) busy(retry, false);
        }
      });
      const dismiss = button('Dismiss', async () => {
        try {
          await ctx.api.post(`/api/intake/${encodeURIComponent(d.intake_id)}/dismiss`, {});
          ctx.navigate('#/new');
        } catch (err) {
          toast(err.message, 'bad');
        }
      }, { kind: 'quiet', key: 'intake-dismiss' });
      body.append(card('Not identified', [callout(idn.error || 'The project could not be identified.', 'bad'), (idn.notes || []).filter((n) => n !== idn.error).map((n) => callout(n, 'info')), h('div', { class: 'btn-row' }, retry, dismiss)]));
    } else if (d.status === 'canceled') {
      body.append(callout('This request was dismissed. Nothing was researched.', 'info'));
    }
    const prog = progressBlock(ctx, d, load);
    if (prog) body.append(prog);
    body.append(details('History', h('ol', { class: 'intake-events' }, (d.events || []).slice().reverse().map((e) => h('li', null, h('span', { class: 'faint' }, fmtDateTime(e.at)), ' ', e.what))), { id: `intake-history-${d.intake_id}` }));
    return d;
  };
  async function load() {
    stopPolling();
    let out;
    try {
      out = await ctx.api.get(`/api/intake/${encodeURIComponent(id)}`);
    } catch (err) {
      if (!body.firstChild) body.append(h('h1', null, 'Research request'), callout(`Could not load this request: ${err.message}`, 'bad'));
      else toast(`Could not refresh: ${err.message}`, 'bad');
      return schedule(null);
    }
    if (seq !== view.seq) return null;
    if (out.intake.input.screenshot && shot === null) {
      shot = (await screenshotFor(ctx, id)) || '';
      view.shots.clear();
      view.shots.set(id, shot);
    }
    const d = draw(out);
    return schedule(d);
  }
  function schedule(d) {
    if (seq !== view.seq) return null;
    const moving = !d || d.status === 'identifying' || (d.status === 'researching' && d.research && ['queued', 'dispatching', 'running'].includes(d.research.state));
    if (!moving) return d;
    view.timer = setTimeout(() => {
      if (seq !== view.seq || !page.isConnected) return;
      if (document.hidden) return schedule(d);
      load();
    }, POLL_MS);
    return d;
  }
  page.append(h('div', { class: 'crumbs' }, h('a', { href: '#/new' }, 'New research'), h('span', { 'aria-hidden': 'true' }, '›'), h('span', null, 'Request')), body);
  await load();
  return page;
}
