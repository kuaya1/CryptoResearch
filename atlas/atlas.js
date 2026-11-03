/* CryptoResearch — The Living System Atlas: the page.
   Reads window.ATLAS (system.js) and window.ATLAS_EVIDENCE (evidence.generated.js).
   No network, no dependencies, nothing stored. */
(function () {
  'use strict';
  const A = window.ATLAS;
  const EV = window.ATLAS_EVIDENCE || { repo: 'kuaya1/CryptoResearch', commit: 'main', refs: {} };
  const app = document.getElementById('app');
  const byId = Object.fromEntries(A.nodes.map((n) => [n.id, n]));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── Icons (inline stroke SVG) ─────────────────────────── */
  const P = {
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1.2-3.6 3.8-5.5 7-5.5s5.8 1.9 7 5.5"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    both: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.9-3 3-4.6 5.5-4.6"/><circle cx="16.5" cy="15.5" r="4.5"/><path d="M16.5 13.3v2.2l1.6 1"/>',
    call: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>',
    read: '<path d="M4 5c3-1 6-1 8 1v13c-2-2-5-2-8-1zM20 5c-3-1-6-1-8 1v13c2-2 5-2 8-1z"/>',
    code: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
    gate: '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>'
  };
  const ic = (n, cls) => `<svg ${cls ? `class="${cls}"` : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n]}</svg>`;
  const ctlIcon = { human: 'person', automated: 'clock', mixed: 'both', passive: 'call' };

  /* ── Evidence links ────────────────────────────────────── */
  function evLink([p, a]) {
    const line = EV.refs[`${p}|${a}`];
    const enc = p.split('/').map(encodeURIComponent).join('/');
    const url = `https://github.com/${EV.repo}/blob/${EV.commit}/${enc}${line ? `#L${line}` : ''}`;
    const what = !a ? 'file' : a.startsWith('~') ? `“${a.slice(1)}”` : `${a}()`;
    return { url, label: `${p}${line ? `:${line}` : ''}`, what };
  }
  const evHtml = (e) => { const l = evLink(e); return `<a href="${esc(l.url)}" target="_blank" rel="noopener">${ic('code')}<span>${esc(l.label)} <em>${esc(l.what)}</em></span></a>`; };
  const sha = esc(EV.commit.slice(0, 7));
  document.getElementById('pin').innerHTML = `Static map · source baseline <code>${sha}</code>`;
  document.getElementById('pin').title = `${A.staticNotice} ${A.baseline.note}`;

  const stMark = (s) => `<i class="st-mark st-${s}" aria-hidden="true"></i>`;
  const statusPill = (s) => `<span class="pill">${stMark(s)}${esc(A.statuses[s].name)}</span>`;
  const controlPill = (c) => `<span class="pill">${ic(ctlIcon[c])}${esc(A.controls[c].name)}</span>`;
  const chapterOf = (id) => A.chapters.find((c) => (c.nodes || []).includes(id));
  const evCount = Object.keys(EV.refs).length;
  const claimsOf = (where) => (EV.claims || []).filter((c) => c.where === where);
  const claimUrl = (c) => `https://github.com/${EV.repo}/blob/${EV.commit}/${c.path.split('/').map(encodeURIComponent).join('/')}#L${c.line}`;

  /* The four status facts for a part, kept apart. Unknown where the
     repository holds no evidence; each desk's current settings are never read. */
  const UNKNOWN = 'UNKNOWN';
  function fields(n) {
    const ext = n.kind === 'external', gh = /^\.github\//.test((n.evidence[0] || [])[0] || '') || ['ci', 'grok-scout', 'eng-loop'].includes(n.id);
    const impl = n.status === 'planned' ? 'Not built: a specification and preflight exist'
      : n.status === 'retired' ? 'Removed on purpose'
      : ext ? 'Outside service; the desk’s client code is at ' + sha : `Yes, at ${sha}`;
    const en = n.status === 'planned' || n.status === 'retired' ? '—'
      : n.control === 'human' ? 'Acts only when Eric does'
      : n.status === 'gated' ? `Off by default; each desk’s setting ${UNKNOWN}`
      : `On by default; each desk’s setting ${UNKNOWN}`;
    const dep = n.deployed || (n.status === 'planned' ? 'Not created' : n.status === 'retired' ? 'Removed'
      : ext ? 'Not ours to deploy'
      : gh ? 'Runs on GitHub from main'
      : n.band === 'engineering' ? 'A practice, not a service'
      : `Online desk: ${UNKNOWN} at this baseline; last receipt ${A.baseline.deployed.rev} (R0, ${A.baseline.deployed.at}). PC desk: ${UNKNOWN}`);
    const pr = n.proof ? n.proof.words : n.status === 'planned' || n.status === 'retired' ? '—' : `${UNKNOWN}: no receipt cited`;
    return [['Implemented', impl], ['Enabled', en], ['Deployed', dep], ['Operating proven', pr, n.proof && n.proof.evidence]];
  }
  const DEFAULT_IMPL = `Yes, at ${sha}`;
  const DEFAULT_DEP = () => `Online desk: ${UNKNOWN} at this baseline; last receipt ${A.baseline.deployed.rev} (R0, ${A.baseline.deployed.at}). PC desk: ${UNKNOWN}`;
  const fieldsHtml = (n, brief) => `<dl class="facts4">${fields(n).filter(([k, v]) => !brief || !((k === 'Implemented' && v === DEFAULT_IMPL) || (k === 'Deployed' && v === DEFAULT_DEP()))).map(([k, v, e]) => `<div><dt>${k}</dt><dd${/UNKNOWN|^None|^Not current/.test(v) ? ' class="unk"' : ''}>${esc(v)}${e ? ` ${e.map((x) => { const l = evLink(x); return `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`; }).join(' ')}` : ''}</dd></div>`).join('')}</dl>`;
  const claimsHtml = (where) => { const cs = claimsOf(where); return cs.length ? `<ul class="claims">${cs.map((c) => `<li>${ic('gate')}<span>${esc(c.what)}</span><a href="${esc(claimUrl(c))}" target="_blank" rel="noopener">${esc(c.path.split('/').pop())}:${c.line}</a></li>`).join('')}</ul>` : ''; };

  /* ── Router ────────────────────────────────────────────── */
  let teardown = null;
  function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const [top, a, b, c] = h.split('/');
    document.querySelectorAll('[data-nav]').forEach((el) => el.toggleAttribute('aria-current', false));
    if (teardown) { teardown(); teardown = null; }
    document.body.style.overflow = '';
    document.body.classList.toggle('printing', top === 'print');
    if (top === 'print') {
      document.title = 'CryptoResearch — The Living System Atlas';
      teardown = renderPrint();
    } else if (top === 'map') {
      document.querySelector('[data-nav="map"]').setAttribute('aria-current', 'page');
      document.title = 'Map · CryptoResearch System Atlas';
      teardown = renderMap(a === 'path' ? { flow: b, step: c ? +c : 0 } : { node: a });
    } else if (top === 'read') {
      document.querySelector('[data-nav="read"]').setAttribute('aria-current', 'page');
      document.title = 'Litepaper · CryptoResearch System Atlas';
      teardown = renderPaper(a);
    } else {
      document.title = 'CryptoResearch · System Atlas';
      teardown = renderCover();
    }
  }
  window.addEventListener('hashchange', route);

  /* ── Cover ─────────────────────────────────────────────── */
  function strip(live) {
    return `<div class="strip${live ? ' live' : ''}">${A.layers.map((l) => `<div class="st"><b>${esc(l.name)}</b><span>${esc(l.note)}</span></div>`).join('')}</div>
      <div class="bands">${A.bands.map((b) => `<div><b>${esc(b.name)}</b>${esc(b.note)}</div>`).join('')}</div>`;
  }
  function renderCover() {
    window.scrollTo(0, 0);
    app.innerHTML = `<section class="cover">
      <div class="eyebrow">CryptoResearch · read from the code</div>
      <h1>The Living System Atlas</h1>
      <p class="lede">A private research desk where models read and argue, code measures and keeps the books, and Eric decides. Here is the code at one baseline, each part linked to the source that makes it true, with what is switched on, deployed and proven kept apart.</p>
      <p class="static-note">${esc(A.staticNotice)}</p>
      <div class="doors">
        <a class="door" href="#/read"><span class="n">I</span><h2>The Litepaper</h2><p>Thirteen short chapters, from the owner’s map to what is held, unproven and next.</p><div class="go">Start reading →</div></a>
        <a class="door" href="#/map"><span class="n">II</span><h2>The Map</h2><p>The five handoffs first; then every component and connection. Follow a path from a link to a decision.</p><div class="go">Open the map →</div></a>
      </div>
      <div class="facts">
        <div><b>${A.nodes.length}</b>components</div>
        <div><b>${A.edges.length}</b>connections</div>
        <div><b>${evCount}</b>source links</div>
        <div><b>${(EV.claims || []).length}</b>claims checked in code</div>
        <div><b>${sha}</b>source baseline</div>
      </div>
      <div class="hero-fig">${FIG.owner(true)}</div>
    </section>`;
    return null;
  }

  /* ── Litepaper figures ─────────────────────────────────── */
  const arr = `<div class="arr">${ic('arrow')}</div>`;
  const box = (b, s, cls) => `<div class="box${cls ? ' ' + cls : ''}"><b>${esc(b)}</b>${s ? `<span>${esc(s)}</span>` : ''}</div>`;
  const FIG = {
    principles: () => `<div class="tri">
        <div>${ic('spark')}<b>Models read and argue</b><span>Claude, ChatGPT and Gemini research. A second Claude prosecutes. They write words, never amounts.</span></div>
        <div>${ic('code')}<b>Code measures and keeps books</b><span>Grades, sizing, exits, orders and stops are deterministic JavaScript with exact decimals.</span></div>
        <div>${ic('person')}<b>Eric decides</b><span>Every decision is his or a paper mandate’s he armed; every switch that enables automation, and every merge, is his. Nothing reaches live capital.</span></div></div>`,
    layers: () => strip(false),
    owner: (compact) => `<div class="owner${compact ? ' compact' : ''}">
        <ol class="stages">${A.owner.map((s, i) => `<li class="stage-${s.id}"><span class="sn">${i + 1}</span><b>${esc(s.name)}</b><em>${esc(s.q)}</em>
          ${compact ? '' : `<p>${esc(s.text)}</p>`}<span class="out">${ic('arrow')}${esc(s.out)}</span></li>`).join('')}</ol>
        <div class="support">${A.ownerSupport.map((s) => `<div><b>${esc(s.name)}</b>${compact ? '' : `<span>${esc(s.text)}</span>`}</div>`).join('')}</div></div>`,
    admission: () => `<div class="branches">
        <div><b>Eric confirms</b><span>He picks one of the CoinGecko candidates, or clicks “Confirm and request research” on the scout leads he saw.</span><i class="who">Manual</i></div>
        <div><b>A single exact match confirms itself</b><span>Only when his own CoinGecko link or exact contract resolves to one unambiguous listing. Never a name search or a screenshot.</span><i class="who">Automatic, his input</i></div>
        <div><b>Automatic admission</b><span>Eligible scout leads, up to his daily limit, until the expiry he set. Off by default; blocked while paused.</span><i class="who">Automatic, if armed</i></div></div>`,
    research: () => `<div class="flowfig">${box('One prompt', 'pinned @6, frozen to the byte')}${arr}
        <div class="box many"><div>Claude</div><div>ChatGPT</div><div>Gemini · on hold</div></div>${arr}
        ${box('One path in', 'bound to its run')}${arr}${box('The desk grades', 'never averaged', 'dark')}</div>
        <figcaption>Each model’s report keeps its own grade. A missing component withholds the grade rather than guess it.</figcaption>`,
    agents: () => `<div class="flowfig">${box('Agent 1', 'Researcher writes the case')}${arr}${box('Claude’s report', 'graded by the desk')}${arr}
        ${box('Agent 2', 'Prosecutor attacks it')}${arr}${box('One ticket', 'entry, target, invalidation', 'dark')}</div>
        <figcaption>Two separate Claude sessions on Eric’s subscription, one project at a time. They stop at his review.</figcaption>`,
    decision: () => `<div class="flowfig"><div class="box many"><div>Grade</div><div>Exit reading &lt; 72 h</div><div>Already held?</div></div>${arr}
        ${box('Sizing gate', 'fixed rules in code')}${arr}<div class="box many"><div>$500 ceiling</div><div>$250 ceiling</div><div>$0: held or below floor</div></div>${arr}
        ${box('Eric, or his armed mandate', 'a grant up to the ceiling', 'dark')}</div>
        <figcaption>The suggested risk is a ceiling on the loss a grant may plan for. A grant is not an order, and an order is not a fill.</figcaption>`,
    books: () => `<div class="quad">${A.views.map((v) => `<div><b>${esc(v.name)}</b><span>${esc(v.text)}</span></div>`).join('')}</div>
        <div class="chain"><span><b>Risk ceiling</b>the gate’s suggestion</span>${ic('arrow')}<span><b>Grant</b>Eric’s or the mandate’s, ≤ ceiling</span>${ic('arrow')}<span><b>Intent</b>planned loss at the stop; quantity and notional follow</span>${ic('arrow')}<span><b>Order</b>accepted, refused or waiting</span>${ic('arrow')}<span><b>Fill</b>only from closed hours</span></div>
        <figcaption>Four records, four totals, never added together. The chain applies to the Trader simulation; the PM benchmark stops at the grant.</figcaption>`,
    control: () => `<div class="authority">${A.authority.map((a) => `<div><b>${esc(a.name)}</b><i>${esc(a.who)}</i><span>${esc(a.text)}</span></div>`).join('')}</div>
        <div class="pause"><div><b>The desk-wide pause stops</b><ul>${A.pause.stops.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>
          <div><b>It leaves running</b><ul>${A.pause.continues.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div></div>
        <div class="pc-s cites">${A.pause.evidence.map((e) => { const l = evLink(e); return `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`; }).join('')}</div>
        <div class="tablebox"><table class="ctl"><thead><tr><th>Automation</th><th>Enabled by</th><th>Default in code</th><th>Stopped by</th></tr></thead><tbody>
        ${[
          ['Grok Scout', 'Repository variable SCOUT_ENABLED', 'Off unless set', 'The variable'],
          ['Automatic admission', 'automation.lead_admission, with an expiry', 'Off', 'Admission off · project stop · pause'],
          ['Paid API research', 'A key, a model, prices, a budget', 'Not configured', 'Pause · model hold'],
          ['Scheduled research', 'research.unattended_enabled', 'Off', 'Pause'],
          ['Pilot runner', 'Eric enables the task and enrolls projects', 'Task Disabled', 'Project stop · pause'],
          ['Paper mandate', 'autonomous_paper_loop and an authority ≤ 30 days', 'Off', 'Mandate off · project stop · pause · any decision of his'],
          ['Trader’s Paper Book', 'trader.book and trader.rules', 'Unset', 'Unfunding the book (a pause leaves settlement running)'],
          ['Exit quotes', 'Monitoring per project, or exit_quotes_auto', 'Off', 'Monitoring off · pause stops the standing policy'],
          ['Contract forensics', 'contracts.enabled and compute caps', 'Off', 'The setting'],
          ['Wallet sync', 'ALCHEMY_API_KEY and a wallet he adds', 'No wallet', 'Removing the key or wallet']
        ].map((r) => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td class="off">${esc(r[2])}</td><td>${esc(r[3])}</td></tr>`).join('')}
        </tbody></table></div>`,
    stage15: () => {
      const S = A.stage15;
      const cite = (e) => { const l = evLink(e); return `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`; };
      const prUrl = (n) => `https://github.com/${esc(EV.repo)}/pull/${n}`;
      return `<p class="static-note">${esc(A.staticNotice)}</p>
        ${Object.entries(S.classes).map(([k, c]) => `<div class="opengroup st15-group st15-${k}"><h3><i class="pip" aria-hidden="true"></i>${esc(c.name)} <span>${esc(c.words)}</span></h3>
          <ul class="openlist">${S.items.filter((i) => i.cls === k).map((i) => `<li><i class="n15">${i.n}</i><b>${esc(i.name)}${i.slice ? ` <em class="slice">${esc(i.slice)}</em>` : ''}</b><p>${esc(i.now)}</p>${i.evidence.map(cite).join('')}</li>`).join('')}</ul></div>`).join('')}
        <p class="st15-note">${esc(S.classSource)}</p>
        <h3 class="st15-h">Where each part runs</h3>
        <div class="tablebox"><table class="st15-table"><thead><tr><th>Host</th><th>What runs there</th></tr></thead><tbody>
          ${S.hosts.map((h) => `<tr><td><b>${esc(h.name)}</b></td><td>${esc(h.runs)} ${cite(h.evidence)}</td></tr>`).join('')}</tbody></table></div>
        <h3 class="st15-h">The sheet’s boxes</h3>
        <p class="st15-note">${esc(S.boxNote)}</p>
        <ol class="st15-boxes">${S.lifecycle.map((b) => `<li>${esc(b)}</li>`).join('')}</ol>
        <p class="st15-note"><b>Over the whole path:</b> ${S.overlays.map(esc).join(' · ')}</p>
        <h3 class="st15-h">Where this status comes from</h3>
        <div class="tablebox"><table class="st15-table"><thead><tr><th>Pull request</th><th>Merge commit</th><th>What it did</th></tr></thead><tbody>
          ${S.prs.map(([n, c, w]) => `<tr><td><a href="${prUrl(n)}" target="_blank" rel="noopener">#${n}</a></td><td>${c ? `<code>${esc(c)}</code>` : 'Not merged'}</td><td>${esc(w)}</td></tr>`).join('')}</tbody></table></div>
        <p class="st15-note">${esc(S.prNote)}</p>`;
    },
    next: () => [['unbuilt', 'Not built', 'The thing does not exist.'], ['disabled', 'Built, off by default', 'In the code; does nothing until enabled.'], ['unproven', 'No operating proof', 'No receipt in the repository shows it working.'], ['questions', 'Still open', 'Eric’s own decisions.']]
      .map(([k, h, sub]) => `<div class="opengroup og-${k}"><h3>${esc(h)} <span>${esc(sub)}</span></h3><ul class="openlist">${A.open[k].map(([t, d, e]) => { const l = evLink(e); return `<li><i class="dash" aria-hidden="true"></i><b>${esc(t)}</b><p>${esc(d)}</p><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a></li>`; }).join('')}</ul></div>`).join('')
  };

  /* ── Litepaper ─────────────────────────────────────────── */
  function renderPaper(target) {
    app.innerHTML = `<div class="paper">
      <nav class="toc" aria-label="Chapters"><ol>${A.chapters.map((c) => `<li><a href="#/read/${c.id}" data-ch="${c.id}"><span>${c.num}</span>${esc(c.title)}</a></li>`).join('')}</ol></nav>
      <article class="text">${A.chapters.map(chapter).join('')}</article></div>`;
    const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add('in')), { rootMargin: '0px 0px -8% 0px' });
    app.querySelectorAll('.reveal').forEach((el) => io.observe(el));
    const spy = new IntersectionObserver((es) => {
      es.forEach((e) => {
        if (!e.isIntersecting) return;
        const id = e.target.id.slice(3);
        app.querySelectorAll('.toc a').forEach((a) => a.setAttribute('aria-current', String(a.dataset.ch === id)));
      });
    }, { rootMargin: '-30% 0px -60% 0px' });
    app.querySelectorAll('.ch').forEach((el) => spy.observe(el));
    const el = target && document.getElementById('ch-' + target);
    if (el) { el.querySelectorAll('.reveal').forEach((r) => r.classList.add('in')); requestAnimationFrame(() => el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' })); }
    else window.scrollTo(0, 0);
    return () => { io.disconnect(); spy.disconnect(); };
  }
  function chapter(c) {
    const nodes = (c.nodes || []).map((id) => byId[id]);
    const flow = c.mapFlow && A.flows.find((f) => f.id === c.mapFlow);
    return `<section class="ch" id="ch-${c.id}" aria-labelledby="h-${c.id}">
      <div class="reveal"><div class="num">${c.num}</div><h2 id="h-${c.id}">${esc(c.title)}</h2><p class="lede">${esc(c.lede)}</p>
      ${c.body.map((p) => `<p>${esc(p)}</p>`).join('')}</div>
      ${c.figure ? `<figure class="fig reveal">${FIG[c.figure]()}</figure>` : ''}
      ${c.deeper ? `<details class="deeper"><summary>The technical detail</summary><ul>${c.deeper.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></details>` : ''}
      ${claimsOf(`chapter ${c.id}`).length ? `<div class="checked"><span class="lbl">Checked in the code</span>${claimsHtml(`chapter ${c.id}`)}</div>` : ''}
      ${nodes.length || flow ? `<div class="onmap"><span class="lbl">On the map</span>
        ${flow ? `<a class="chip path" href="#/map/path/${flow.id}">Follow: ${esc(flow.name)} →</a>` : ''}
        ${nodes.map((n) => `<a class="chip" href="#/map/${n.id}">${stMark(n.status)}${esc(n.name)}</a>`).join('')}</div>` : ''}
      ${c.evidence ? `<div class="cite">${c.evidence.map((e) => { const l = evLink(e); return `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`; }).join('')}</div>` : ''}
    </section>`;
  }

  /* ── Map geometry ──────────────────────────────────────── */
  const COLW = 272, W = 228, H = 72, ROWH = 90, X0 = 40, Y0 = 104;
  const laneRows = Math.max(...A.nodes.filter((n) => n.layer).map((n) => n.row)) + 1;
  const bandTop = { platform: Y0 + laneRows * ROWH + 92 };
  bandTop.engineering = bandTop.platform + 2 * ROWH + 104;
  const STAGE_W = X0 + 5 * COLW + W + 40;
  const STAGE_H = bandTop.engineering + ROWH + 40;
  const pos = (n) => ({ x: X0 + n.col * COLW, y: n.band ? bandTop[n.band] + n.row * ROWH : Y0 + n.row * ROWH });
  const pairKey = (a, b) => `${a}>${b}`;
  const edgeSet = new Set(A.edges.map(([f, t]) => pairKey(f, t)));

  function edgeGeom(f, t) {
    const a = pos(byId[f]), b = pos(byId[t]);
    const off = edgeSet.has(pairKey(t, f)) ? (f < t ? -7 : 7) : 0;
    let sx, sy, ex, ey, c1x, c2x;
    if (Math.abs(a.x - b.x) < 4) {
      sx = a.x + W; ex = b.x + W; sy = a.y + H / 2 + off; ey = b.y + H / 2 + off;
      c1x = sx + 46; c2x = ex + 46;
    } else if (b.x > a.x) {
      sx = a.x + W; ex = b.x - 6; sy = a.y + H / 2 + off; ey = b.y + H / 2 + off;
      const d = Math.max(36, (ex - sx) / 2); c1x = sx + d; c2x = ex - d;
    } else {
      sx = a.x; ex = b.x + W + 6; sy = a.y + H / 2 + off; ey = b.y + H / 2 + off;
      const d = Math.max(36, (sx - ex) / 2); c1x = sx - d; c2x = ex + d;
    }
    const d = `M${sx},${sy} C${c1x},${sy} ${c2x},${ey} ${ex},${ey}`;
    const mx = 0.125 * sx + 0.375 * c1x + 0.375 * c2x + 0.125 * ex, my = 0.5 * sy + 0.5 * ey;
    return { d, mx, my };
  }

  /* ── Map ───────────────────────────────────────────────── */
  function stageMarkup() {
    const lanes = A.layers.map((l, i) => `<div class="lane-bg" style="left:${X0 + i * COLW - 14}px;top:16px;width:${W + 28}px;height:${Y0 + laneRows * ROWH - 30}px"></div>
      <div class="lane-h" style="left:${X0 + i * COLW}px;top:36px">${esc(l.name)}<span>${esc(l.note)}</span></div>`).join('');
    const bands = A.bands.map((b) => `<div class="lane-bg" style="left:${X0 - 14}px;top:${bandTop[b.id] - 64}px;width:${5 * COLW + W + 28}px;height:${(b.id === 'platform' ? 2 : 1) * ROWH + 70}px"></div>
      <div class="band-h" style="left:${X0}px;top:${bandTop[b.id] - 46}px">${esc(b.name)}<span>${esc(b.note)}</span></div>`).join('');
    const nodes = A.nodes.map((n) => { const p = pos(n);
      return `<button class="node k-${n.kind} s-${n.status}" data-id="${n.id}" style="left:${p.x}px;top:${p.y}px"
        aria-label="${esc(`${n.name}. ${n.short}. ${A.statuses[n.status].name}. ${A.controls[n.control].name}.`)}">
        ${stMark(n.status)}<b>${esc(n.name)}</b><span class="s">${esc(n.short)}</span>${n.control !== 'passive' ? ic(ctlIcon[n.control], 'ctl-g') : ''}</button>`; }).join('');
    const edges = A.edges.map(([f, t, label], i) => { const g = edgeGeom(f, t);
      const quiet = !!byId[f].band !== !!byId[t].band;
      return `<g data-e="${i}" data-f="${f}" data-t="${t}"${quiet ? ' class="quiet"' : ''}><path d="${g.d}" marker-end="url(#ah)"/><text x="${g.mx}" y="${g.my - 6}" text-anchor="middle">${esc(label)}</text></g>`; }).join('');
    return `${lanes}${bands}
        <svg class="edges" width="${STAGE_W}" height="${STAGE_H}" aria-hidden="true"><defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z"/></marker></defs>${edges}</svg>
        ${nodes}`;
  }

  function renderMap(init) {
    document.body.style.overflow = 'hidden';
    const counts = (key, val) => A.nodes.filter((n) => n[key] === val).length;

    app.innerHTML = `<div class="mapview" id="mapview">
      <div class="viewport" id="vp"><div class="stage" id="stage" style="width:${STAGE_W}px;height:${STAGE_H}px">${stageMarkup()}</div></div>
      <aside class="panel guide" aria-label="Map guide">
        <h3>The whole system</h3><p class="sub">${A.nodes.length} parts, ${A.edges.length} connections. Drag to move, Ctrl + scroll to zoom, click any part.</p>
        <input class="search" id="q" type="search" placeholder="Find a part…" aria-label="Find a part" autocomplete="off">
        <ul class="results" id="qr"></ul>
        <h4>Follow a path</h4><div class="paths">${A.flows.map((f) => `<button data-flow="${f.id}" aria-pressed="false"><b>${esc(f.name)}</b><span>${esc(f.blurb)}</span></button>`).join('')}</div>
        <h4>Show only</h4><div class="legend">
          ${Object.entries(A.statuses).map(([k, s]) => `<button data-filter="status:${k}" aria-pressed="false" title="${esc(s.words)}">${stMark(k)}${esc(s.name)}<span class="ct">${counts('status', k)}</span></button>`).join('')}
        </div>
        <h4>Who acts</h4><div class="legend">
          ${Object.entries(A.controls).map(([k, c]) => `<button data-filter="control:${k}" aria-pressed="false" title="${esc(c.words)}">${ic(ctlIcon[k])}${esc(c.name)}<span class="ct">${counts('control', k)}</span></button>`).join('')}
        </div>
      </aside>
      <div class="panel viewtoggle" role="group" aria-label="View"><button data-view="owner" aria-pressed="false">Owner view</button><button data-view="map" aria-pressed="true">Full map</button><button data-view="list" aria-pressed="false">List</button></div>
      <div class="ownerview" id="ownerview"><div class="ov-in">
        <h2>Five handoffs</h2><p class="sub">The owner’s view of the system. Each stage answers one question. Pick any part to see it on the full map, with its four status facts.</p>
        <ol class="ov-stages">${A.owner.map((s, i) => `<li><div class="ov-h"><span class="sn">${i + 1}</span><b>${esc(s.name)}</b></div><em>${esc(s.q)}</em><p>${esc(s.text)}</p>
          <div class="ov-nodes">${s.nodes.map((id) => `<button data-id="${id}">${stMark(byId[id].status)}<span>${esc(byId[id].name)}</span></button>`).join('')}</div>
          <span class="out">${ic('arrow')}${esc(s.out)}</span></li>`).join('')}</ol>
        <div class="ov-support">${A.ownerSupport.map((s) => `<div><b>${esc(s.name)}</b><span>${esc(s.text)}</span><div class="ov-nodes">${A.nodes.filter((n) => (s.layer && (n.layer === s.layer || n.support)) || (s.band && n.band === s.band)).map((n) => `<button data-id="${n.id}">${stMark(n.status)}<span>${esc(n.name)}</span></button>`).join('')}</div></div>`).join('')}</div>
        <div class="ov-key">${Object.entries(A.statuses).map(([k, s]) => `<span title="${esc(s.words)}">${stMark(k)} ${esc(s.name)}</span>`).join('')}</div>
      </div></div>
      <div class="panel zoom" role="group" aria-label="Zoom"><button data-z="in" aria-label="Zoom in">${ic('plus')}</button><button data-z="out" aria-label="Zoom out">${ic('minus')}</button><button data-z="fit" aria-label="Fit the whole map">${ic('fit')}</button></div>
      <div class="maplist" id="maplist">${[...A.layers, ...A.bands].map((l) => `<h3>${esc(l.name)}</h3><p class="ln">${esc(l.note)}</p>
        ${A.nodes.filter((n) => (n.layer || n.band) === l.id).map((n) => `<button data-id="${n.id}">${stMark(n.status)}<b>${esc(n.name)}</b><span class="s">${esc(n.short)} · ${esc(A.statuses[n.status].name)}</span></button>`).join('')}`).join('')}</div>
      <aside class="panel detail" id="detail" aria-label="Component detail" aria-hidden="true"></aside>
      <div class="panel tour" id="tour" aria-live="polite"></div>
    </div>`;

    const mv = document.getElementById('mapview'), vp = document.getElementById('vp'), stage = document.getElementById('stage');
    const detail = document.getElementById('detail'), tour = document.getElementById('tour');
    const nodeEls = Object.fromEntries([...stage.querySelectorAll('.node')].map((el) => [el.dataset.id, el]));
    const edgeEls = [...stage.querySelectorAll('g[data-e]')];
    const S = { x: 0, y: 0, k: 1, sel: null, filter: null, flow: null, step: 0 };
    const narrow = () => innerWidth < 760;
    if (!init.node && !init.flow) setView('owner');
    else if (narrow()) setView('list');

    /* view transform */
    const apply = (smooth) => {
      stage.style.transition = smooth && !reduced ? 'transform .55s cubic-bezier(.2,.7,.2,1)' : 'none';
      stage.style.transform = `translate(${S.x}px,${S.y}px) scale(${S.k})`;
    };
    const leftPad = () => (innerWidth > 1000 ? 320 : 16);
    const rightPad = () => (S.sel && innerWidth > 760 ? 424 : 16);
    function fit(smooth) {
      const vw = vp.clientWidth - leftPad() - rightPad(), vh = vp.clientHeight - 32;
      S.k = Math.min(1, Math.max(0.3, Math.min(vw / STAGE_W, vh / STAGE_H)));
      S.x = leftPad() + (vw - STAGE_W * S.k) / 2; S.y = 16 + (vh - STAGE_H * S.k) / 2;
      apply(smooth);
    }
    function center(id, smooth) {
      const p = pos(byId[id]);
      const k = Math.max(S.k, 0.8); S.k = Math.min(k, 1.1);
      const vw = vp.clientWidth - leftPad() - rightPad();
      const tourH = S.flow ? 170 : 0;
      S.x = leftPad() + vw / 2 - (p.x + W / 2) * S.k;
      S.y = (vp.clientHeight - tourH) / 2 - (p.y + H / 2) * S.k;
      apply(smooth);
    }
    function zoomAt(f, cx, cy) {
      const k = Math.min(1.6, Math.max(0.25, S.k * f));
      S.x = cx - (cx - S.x) * (k / S.k); S.y = cy - (cy - S.y) * (k / S.k); S.k = k; apply(false);
    }

    /* drag & wheel */
    let drag = null, moved = false;
    vp.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, sx: S.x, sy: S.y, id: e.pointerId }; moved = false; });
    vp.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      if (!moved) { moved = true; vp.setPointerCapture(drag.id); vp.classList.add('dragging'); }
      S.x = drag.sx + dx; S.y = drag.sy + dy; apply(false);
    });
    const end = () => { drag = null; vp.classList.remove('dragging'); };
    vp.addEventListener('pointerup', end); vp.addEventListener('pointercancel', end);
    vp.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0022), e.clientX - r.left, e.clientY - r.top);
      else { S.x -= e.deltaX; S.y -= e.deltaY; apply(false); }
    }, { passive: false });

    /* highlighting */
    function paint() {
      const f = S.filter, flow = S.flow && A.flows.find((x) => x.id === S.flow);
      const flowIds = flow ? flow.steps.map((s) => s[0]) : null;
      const stepId = flow ? flowIds[S.step] : null;
      const near = new Set();
      if (S.sel) A.edges.forEach(([a, b]) => { if (a === S.sel) near.add(b); if (b === S.sel) near.add(a); });
      const runPairs = new Set();
      if (flow) for (let i = 0; i < S.step; i++) { runPairs.add(pairKey(flowIds[i], flowIds[i + 1])); runPairs.add(pairKey(flowIds[i + 1], flowIds[i])); }
      const matches = (n) => !f || n[f[0]] === f[1];
      const lit = (id) => {
        const n = byId[id];
        if (flow) return flowIds.includes(id);
        if (!matches(n)) return false;
        return !S.sel || id === S.sel || near.has(id);
      };
      for (const [id, el] of Object.entries(nodeEls)) {
        el.classList.toggle('dim', !lit(id));
        el.classList.toggle('sel', id === S.sel && !flow);
        el.classList.toggle('near', !flow && near.has(id));
        el.classList.toggle('step', id === stepId);
        el.classList.toggle('visited', !!flow && flowIds.slice(0, S.step).includes(id));
      }
      for (const g of edgeEls) {
        const a = g.dataset.f, b = g.dataset.t;
        const hot = !flow && S.sel && (a === S.sel || b === S.sel);
        const run = flow && runPairs.has(pairKey(a, b));
        const dim = flow ? !run : (S.sel ? !hot : (!lit(a) || !lit(b)));
        g.classList.toggle('dim', dim);
        g.classList.toggle('lit', !!hot || !!run);
        g.querySelector('path').classList.toggle('hot', !!hot);
        g.querySelector('path').classList.toggle('run', !!run);
        g.querySelector('text').classList.toggle('hot', !!hot || !!run);
      }
      mv.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(!!f && b.dataset.filter === f.join(':'))));
      mv.querySelectorAll('[data-flow]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.flow === S.flow)));
    }

    /* detail panel */
    function openDetail(id) {
      const n = byId[id];
      const out = A.edges.filter((e) => e[0] === id), inc = A.edges.filter((e) => e[1] === id);
      const ch = chapterOf(id);
      const conn = (list, dir) => list.map(([a, b, l]) => { const o = byId[dir === 'out' ? b : a];
        return `<button data-go="${o.id}">${ic(dir === 'out' ? 'arrow' : 'back')}<b>${esc(o.name)}</b><span>${esc(l)}</span></button>`; }).join('');
      detail.innerHTML = `<button class="close" data-close aria-label="Close">${ic('x')}</button><div class="in">
        <div class="kind">${esc(A.kinds[n.kind])} · ${esc((A.layers.find((l) => l.id === n.layer) || A.bands.find((b) => b.id === n.band)).name)}</div>
        <h3>${esc(n.name)}</h3><p class="short">${esc(n.short)}</p>
        <div class="pills">${statusPill(n.status)}${controlPill(n.control)}</div>
        <p class="sum">${esc(n.summary)}</p>
        ${n.detail ? `<ul>${n.detail.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
        <h4>Status, four separate facts</h4>${fieldsHtml(n)}
        ${n.gates ? `<h4>What has to be true</h4><ul class="gates">${n.gates.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
        ${claimsOf(`node ${n.id}`).length ? `<h4>Checked in the code at ${sha}</h4>${claimsHtml(`node ${n.id}`)}` : ''}
        ${out.length ? `<h4>Sends to</h4><div class="conns">${conn(out, 'out')}</div>` : ''}
        ${inc.length ? `<h4>Receives from</h4><div class="conns">${conn(inc, 'in')}</div>` : ''}
        <h4>Source on GitHub</h4><div class="src">${n.evidence.map(evHtml).join('')}</div>
        ${ch ? `<h4>In the litepaper</h4><a class="read" href="#/read/${ch.id}">${ch.num} · ${esc(ch.title)} →</a>` : ''}
      </div>`;
      detail.classList.add('open'); detail.setAttribute('aria-hidden', 'false'); mv.classList.add('has-detail');
      detail.scrollTop = 0;
    }
    function closeDetail() { detail.classList.remove('open'); detail.setAttribute('aria-hidden', 'true'); mv.classList.remove('has-detail'); }

    function select(id, { smooth = true, focus = false } = {}) {
      S.sel = id; S.flow = null; tour.classList.remove('open');
      if (id) { openDetail(id); if (mv.classList.contains('list')) { /* list keeps its place */ } else center(id, smooth); }
      else closeDetail();
      history.replaceState(null, '', id ? `#/map/${id}` : '#/map');
      paint();
      if (focus && id) detail.querySelector('.close').focus();
    }

    /* tours */
    function startFlow(fid, step = 0) {
      const flow = A.flows.find((f) => f.id === fid); if (!flow) return;
      S.flow = fid; S.step = Math.max(0, Math.min(step, flow.steps.length - 1)); S.sel = null;
      if (mv.classList.contains('list')) setView('map');
      drawTour(); paint();
      const id = flow.steps[S.step][0];
      if (innerWidth > 1100) openDetail(id); else closeDetail();
      center(id, true);
      history.replaceState(null, '', `#/map/path/${fid}/${S.step}`);
    }
    function drawTour() {
      const flow = A.flows.find((f) => f.id === S.flow), [id, text] = flow.steps[S.step], last = S.step === flow.steps.length - 1;
      tour.innerHTML = `<div class="top"><b>${esc(flow.name)}</b><span>Step ${S.step + 1} of ${flow.steps.length} · ${esc(byId[id].name)}</span><button class="x" data-endtour>End</button></div>
        <p>${esc(text)}</p>
        <div class="ctrl"><div class="dots" aria-hidden="true">${flow.steps.map((_, i) => `<i class="${i <= S.step ? 'on' : ''}"></i>`).join('')}</div>
        <button class="btn" data-prev ${S.step ? '' : 'disabled'}>Back</button>
        <button class="btn solid" data-next>${last ? 'Finish' : 'Next'}</button></div>`;
      tour.classList.add('open');
    }
    function endFlow() { S.flow = null; tour.classList.remove('open'); closeDetail(); paint(); history.replaceState(null, '', '#/map'); }

    function setView(v) {
      mv.classList.toggle('list', v === 'list');
      mv.classList.toggle('owner', v === 'owner');
      mv.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
    }

    /* events */
    mv.addEventListener('click', (e) => {
      const t = e.target.closest('button, a'); if (!t) { if (!moved && e.target.closest('#vp') && (S.sel)) select(null); return; }
      if (t.classList.contains('node')) { if (moved) return; select(t.dataset.id === S.sel ? null : t.dataset.id); return; }
      if (t.closest('#maplist') && t.dataset.id) { select(t.dataset.id); return; }
      if (t.closest('#ownerview') && t.dataset.id) { setView(narrow() ? 'list' : 'map'); fit(false); select(t.dataset.id, { smooth: false }); return; }
      if (t.dataset.go) { if (S.flow) endFlow(); select(t.dataset.go); return; }
      if (t.hasAttribute('data-close')) { if (S.flow) endFlow(); else select(null); return; }
      if (t.dataset.flow) { S.flow === t.dataset.flow ? endFlow() : startFlow(t.dataset.flow); return; }
      if (t.hasAttribute('data-next')) { const f = A.flows.find((x) => x.id === S.flow); if (S.step >= f.steps.length - 1) endFlow(); else startFlow(S.flow, S.step + 1); return; }
      if (t.hasAttribute('data-prev')) { startFlow(S.flow, S.step - 1); return; }
      if (t.hasAttribute('data-endtour')) { endFlow(); return; }
      if (t.dataset.filter) { const f = t.dataset.filter.split(':'); S.filter = S.filter && S.filter.join(':') === t.dataset.filter ? null : f; paint(); return; }
      if (t.dataset.view) { setView(t.dataset.view); if (t.dataset.view === 'map') fit(false); return; }
      if (t.dataset.z) { const r = vp.getBoundingClientRect(); if (t.dataset.z === 'fit') fit(true); else zoomAt(t.dataset.z === 'in' ? 1.2 : 1 / 1.2, r.width / 2, r.height / 2); return; }
      if (t.dataset.pick) { q.value = ''; qr.innerHTML = ''; select(t.dataset.pick, { focus: true }); }
    });
    const q = document.getElementById('q'), qr = document.getElementById('qr');
    q.addEventListener('input', () => {
      const s = q.value.trim().toLowerCase();
      qr.innerHTML = !s ? '' : A.nodes.filter((n) => `${n.name} ${n.short} ${n.summary}`.toLowerCase().includes(s)).slice(0, 8)
        .map((n) => `<li><button data-pick="${n.id}">${stMark(n.status)}${esc(n.name)}</button></li>`).join('') || '<li style="padding:8px 10px;font-size:13.5px;color:var(--ink-3)">Nothing by that name</li>';
    });
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const b = qr.querySelector('[data-pick]'); if (b) b.click(); } });
    const onKey = (e) => {
      if (e.key === 'Escape') { if (S.flow) endFlow(); else if (S.sel) select(null); }
      if (S.flow && !e.target.closest('input')) {
        if (e.key === 'ArrowRight') mv.querySelector('[data-next]').click();
        if (e.key === 'ArrowLeft' && S.step) startFlow(S.flow, S.step - 1);
      }
    };
    document.addEventListener('keydown', onKey);
    const onResize = () => { if (!S.sel && !S.flow) fit(false); };
    addEventListener('resize', onResize);

    fit(false);
    if (init.flow) { if (mv.classList.contains('owner')) setView('map'); startFlow(init.flow, init.step); }
    else if (init.node && byId[init.node]) select(init.node, { smooth: false });
    else paint();
    return () => { document.removeEventListener('keydown', onKey); removeEventListener('resize', onResize); };
  }

  /* ── The printable document (#/print → the PDF) ───────── */
  function renderPrint() {
    window.scrollTo(0, 0);
    const built = new Date(EV.built || Date.now()).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const groups = [...A.layers, ...A.bands];
    const place = (n) => groups.find((g) => g.id === (n.layer || n.band)).name;
    const linkList = (list) => list.map((e) => { const l = evLink(e); return `<a href="${esc(l.url)}">${esc(l.label)}</a>`; }).join('');
    const component = (n) => {
      const out = A.edges.filter((e) => e[0] === n.id), inc = A.edges.filter((e) => e[1] === n.id);
      const cs = claimsOf(`node ${n.id}`);
      return `<div class="pc">
        <div class="pc-h"><b>${esc(n.name)}</b><span>${esc(A.kinds[n.kind])} · ${esc(place(n))}</span></div>
        <div class="pc-m">${stMark(n.status)} ${esc(A.statuses[n.status].name)} · ${esc(A.controls[n.control].name)}</div>
        <p>${esc(n.summary)}</p>
        ${n.detail ? `<ul>${n.detail.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
        ${fieldsHtml(n, true)}
        ${n.gates ? `<div class="pc-r"><em>What has to be true</em> ${n.gates.map(esc).join(' · ')}</div>` : ''}
        ${cs.length ? `<div class="pc-r"><em>Checked in the code</em> ${cs.map((c) => `${esc(c.what)} (<a href="${esc(claimUrl(c))}">${esc(c.path.split('/').pop())}:${c.line}</a>)`).join(' · ')}</div>` : ''}
        ${out.length ? `<div class="pc-r"><em>Sends to</em> ${out.map(([, t, l]) => `${esc(byId[t].name)} (${esc(l)})`).join(' · ')}</div>` : ''}
        ${inc.length ? `<div class="pc-r"><em>Receives from</em> ${inc.map(([f, , l]) => `${esc(byId[f].name)} (${esc(l)})`).join(' · ')}</div>` : ''}
        <div class="pc-s">${linkList(n.evidence)}</div></div>`;
    };
    // The full map in three pages, each large enough to read (component names
    // print at about 9.5 pt): the first three columns, the last three, then
    // the two bands in two halves. Each page carries its own key. Region
    // coordinates are stage pixels; a page's regions share one scale.
    const laneH = Y0 + laneRows * ROWH;
    const half = X0 + 2 * COLW + W + 30, right = X0 + 3 * COLW - 30;
    const bandY = bandTop.platform - 80, bandH = STAGE_H - bandY;
    const pages = [
      { t: 'Evidence services, Identify, Research', rs: [{ x: 0, y: 0, w: half, h: laneH }] },
      { t: 'Challenge, Authorize, Record', rs: [{ x: right, y: 0, w: STAGE_W - right, h: laneH }] },
      { t: 'Platform and Engineering', rs: [{ x: 0, y: bandY, w: half, h: bandH }, { x: right, y: bandY, w: STAGE_W - right, h: bandH }] }
    ];
    const key = `<div class="keyline">${Object.entries(A.statuses).map(([k, s]) => `<span>${stMark(k)} ${esc(s.name)}</span>`).join('')}
      ${['human', 'automated', 'mixed'].map((k) => `<span>${ic(ctlIcon[k])} ${esc(A.controls[k].name)}</span>`).join('')}<span>✦ AI agent</span></div>`;
    const mapPage = (pg, i) => {
      const s = Math.min(...pg.rs.map((r) => Math.min(672 / r.w, 780 / pg.rs.length / r.h - 0.01)));
      return `<section class="pp mapp">
        <h2 class="ph">II · The full map, ${i + 1} of 3 <span>${esc(pg.t)}</span></h2>
        ${pg.rs.map((r) => `<div class="sheet" style="width:${Math.round(r.w * s)}px;height:${Math.round(r.h * s)}px"><div class="zoomer" style="zoom:${s.toFixed(4)};width:${Math.floor(r.w)}px;height:${Math.floor(r.h)}px;overflow:hidden">
          <div class="stage" style="width:${STAGE_W}px;height:${STAGE_H}px;margin-left:${-r.x}px;margin-top:${-r.y}px">${stageMarkup()}</div></div></div>`).join('')}
        ${key}
        <p class="note">${i < 2 ? 'Arrows that leave the page continue on the other map page. ' : ''}Every connection, with what passes along it, is listed in the component reference.</p>
      </section>`;
    };
    const statusRows = [
      ['Implemented', 'Code exists at the baseline.', `Read from the repository at ${sha}; the build checks each cited line and claim.`],
      ['Enabled', 'Configuration permits it to act.', 'Only the default in code is given. Each desk’s current settings are not read: UNKNOWN.'],
      ['Deployed', 'The named revision is serving.', `The last receipt, R0: the online desk served ${A.baseline.deployed.rev} at ${A.baseline.deployed.at}, older than this baseline. Current revision: UNKNOWN. The PC desk: UNKNOWN.`],
      ['Operating proven', 'The workflow completed correctly.', 'Given only where a repository receipt says so; otherwise UNKNOWN or “none recorded”.']
    ];
    app.innerHTML = `<div class="printdoc">
      <section class="pp cover-p">
        <div class="eyebrow">CryptoResearch · read from the code</div>
        <h1>The Living System Atlas</h1>
        <p class="lede">A private research desk where models read and argue, code measures and keeps the books, and Eric decides. A visual litepaper and a map of the whole system at one source baseline, each part linked to the source that makes it true.</p>
        <div class="facts">
          <div><b>${A.nodes.length}</b>components</div><div><b>${A.edges.length}</b>connections</div>
          <div><b>${evCount}</b>source links</div><div><b>${(EV.claims || []).length}</b>claims checked</div></div>
        <div class="hero-fig">${FIG.owner(true)}</div>
        <div class="baseline"><b>Source baseline ${sha}</b> · ${esc(EV.repo)} · built ${esc(built)}<br>${esc(A.baseline.deployed.words)}<br>${esc(A.staticNotice)}<br>This atlas describes code. It grants no authority, and it is not proof that code, deployment and operation match.</div>
      </section>

      <section class="pp">
        <h2 class="ph">Contents</h2>
        <ol class="ptoc">
          <li><span>I</span>The Litepaper</li>
          ${A.chapters.map((c) => `<li class="sub"><span>${c.num}</span>${esc(c.title)}</li>`).join('')}
          <li><span>II</span>The full map, in three pages</li>
          <li><span>III</span>Six guided paths</li>
          <li><span>IV</span>Component reference</li>
          <li><span>V</span>How to read this atlas, and what it could not establish</li>
        </ol>
      </section>

      ${A.chapters.map((c) => `<section class="pp ch-p">
        <header class="ch-head"><div class="num">${c.num}</div><h2>${esc(c.title)}</h2><p class="lede">${esc(c.lede)}</p></header>
        ${c.body.map((p) => `<p>${esc(p)}</p>`).join('')}
        ${c.figure ? `<figure class="fig fig-${c.figure}">${FIG[c.figure]()}</figure>` : ''}
        ${c.deeper ? `<div class="deep"><b>The technical detail</b><ul>${c.deeper.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>` : ''}
        ${claimsOf(`chapter ${c.id}`).length ? `<div class="pc-r"><em>Checked in the code</em> ${claimsOf(`chapter ${c.id}`).map((x) => `${esc(x.what)} (<a href="${esc(claimUrl(x))}">${esc(x.path.split('/').pop())}:${x.line}</a>)`).join(' · ')}</div>` : ''}
        ${c.nodes ? `<p class="seealso">On the map: ${c.nodes.map((id) => esc(byId[id].name)).join(' · ')}</p>` : ''}
        ${c.evidence ? `<div class="pc-s">${linkList(c.evidence)}</div>` : ''}
      </section>`).join('')}

      ${pages.map(mapPage).join('')}

      <section class="pp">
        <h2 class="ph">III · Six guided paths</h2>
        ${A.flows.map((f) => `<div class="pflow"><h3>${esc(f.name)}</h3><p class="note">${esc(f.blurb)}</p>
          <ol>${f.steps.map(([id, t]) => `<li><b>${esc(byId[id].name)}</b> ${esc(t)}</li>`).join('')}</ol></div>`).join('')}
      </section>

      <section class="pp">
        <h2 class="ph">IV · Component reference</h2>
        <div class="defaults"><b>Unless a part says otherwise</b><span>Implemented: yes, at ${sha}.</span><span>Deployed: ${esc(DEFAULT_DEP())}.</span><span>Enabled gives the default in code; what each desk is set to now is not read, so it is UNKNOWN.</span></div>
        ${groups.map((g) => `<div class="pgroup"><h3>${esc(g.name)} <span>${esc(g.note)}</span></h3>
          <div class="pcs">${A.nodes.filter((n) => (n.layer || n.band) === g.id).map(component).join('')}</div></div>`).join('')}
      </section>

      <section class="pp">
        <h2 class="ph">V · How to read this atlas</h2>
        <p>Every component, connection and claim was read from the repository’s code and documents. Each source link opens the exact line on GitHub, pinned to commit <code>${sha}</code>, so it keeps pointing at what was read even as the code moves on.</p>
        <p>The build reads every file as it is at that commit. It checks that each cited function, constant or line exists (${evCount} source links), and that each claim the words depend on, a default, a limit or a refusal, matches the code (${(EV.claims || []).length} claims). It refuses to produce the atlas if any fails, if a connection names a part that does not exist, or if a part of the five stages belongs to none or to two. A matching claim proves the code says it; it does not prove the system ran.</p>
        <h3 class="sh">Four status facts</h3>
        <div class="tablebox"><table class="ctl"><thead><tr><th>Fact</th><th>Means</th><th>What this atlas used</th></tr></thead><tbody>
          ${statusRows.map((r) => `<tr><td><b>${esc(r[0])}</b></td><td>${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`).join('')}
        </tbody></table></div>
        <h3 class="sh">The marks on the map</h3>
        <div class="tablebox"><table class="ctl"><tbody>
          ${Object.entries(A.statuses).map(([k, s]) => `<tr><td>${stMark(k)} ${esc(s.name)}</td><td>${esc(s.words)}</td></tr>`).join('')}
          ${Object.entries(A.controls).map(([, c]) => `<tr><td>${esc(c.name)}</td><td>${esc(c.words)}</td></tr>`).join('')}
        </tbody></table></div>
        <h3 class="sh">What this atlas could not establish</h3>
        <ul class="unres">${A.unresolved.map(([t, d]) => `<li><b>${esc(t)}</b> ${esc(d)}</li>`).join('')}</ul>
      </section>
    </div>`;
    return null;
  }

  route();
})();
