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
  document.getElementById('pin').innerHTML = `Read from <code>main</code> at <code>${esc(EV.commit.slice(0, 7))}</code>`;

  const stMark = (s) => `<i class="st-mark st-${s}" aria-hidden="true"></i>`;
  const statusPill = (s) => `<span class="pill">${stMark(s)}${esc(A.statuses[s].name)}</span>`;
  const controlPill = (c) => `<span class="pill">${ic(ctlIcon[c])}${esc(A.controls[c].name)}</span>`;
  const chapterOf = (id) => A.chapters.find((c) => (c.nodes || []).includes(id));
  const evCount = Object.keys(EV.refs).length;

  /* ── Router ────────────────────────────────────────────── */
  let teardown = null;
  function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const [top, a, b, c] = h.split('/');
    document.querySelectorAll('[data-nav]').forEach((el) => el.toggleAttribute('aria-current', false));
    if (teardown) { teardown(); teardown = null; }
    document.body.style.overflow = '';
    if (top === 'map') {
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
      <p class="lede">A private research desk where models read and argue, code measures and keeps the books, and Eric decides. Here is all of it, in one place, each part linked to the source that makes it true.</p>
      <div class="doors">
        <a class="door" href="#/read"><span class="n">I</span><h2>The Litepaper</h2><p>Twelve short chapters, from what the desk is to what is not built yet.</p><div class="go">Start reading →</div></a>
        <a class="door" href="#/map"><span class="n">II</span><h2>The Map</h2><p>Every component and connection. Click anything, or follow a path from a link to a decision.</p><div class="go">Open the map →</div></a>
      </div>
      <div class="facts">
        <div><b>${A.nodes.length}</b>components</div>
        <div><b>${A.edges.length}</b>connections</div>
        <div><b>${A.flows.length}</b>guided paths</div>
        <div><b>${evCount}</b>source links</div>
        <div><b>${A.nodes.filter((n) => n.control === 'human').length}</b>places only Eric acts</div>
      </div>
      <div class="hero-fig">${strip(true)}</div>
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
        <div>${ic('person')}<b>Eric decides</b><span>Every decision, every switch that arms automation, and every merge is his.</span></div></div>`,
    layers: () => strip(false),
    research: () => `<div class="flowfig">${box('One prompt', 'pinned @6, frozen to the byte')}${arr}
        <div class="box many"><div>Claude</div><div>ChatGPT</div><div>Gemini · on hold</div></div>${arr}
        ${box('One path in', 'bound to its run')}${arr}${box('The desk grades', 'never averaged', 'dark')}</div>
        <figcaption>Each model’s report keeps its own grade. A missing component withholds the grade rather than guess it.</figcaption>`,
    agents: () => `<div class="flowfig">${box('Agent 1', 'Researcher writes the case')}${arr}${box('Claude’s report', 'graded by the desk')}${arr}
        ${box('Agent 2', 'Prosecutor attacks it')}${arr}${box('One ticket', 'entry, target, invalidation', 'dark')}</div>
        <figcaption>Two separate Claude sessions on Eric’s subscription, one project at a time. They stop at his review.</figcaption>`,
    decision: () => `<div class="flowfig"><div class="box many"><div>Grade</div><div>Exit reading &lt; 72 h</div><div>Already held?</div></div>${arr}
        ${box('Sizing gate', 'fixed rules in code')}${arr}<div class="box many"><div>$500 standard</div><div>$250 starter</div><div>$0 held or below floor</div></div>${arr}
        ${box('Eric', 'Approve · Halve · Veto · Pass', 'dark')}</div>`,
    books: () => `<div class="tri">
        <div><b>PM Paper Book</b><span>Eric’s own grants at the signal price, compared with BTC. No totals before 20 closed.</span></div>
        <div><b>Trader’s Paper Book</b><span>Simulated execution: intents, a risk engine, a file for a venue, fills from closed hours.</span></div>
        <div><b>Research vs BTC</b><span>Every eligible report measured at 30, 60, 90 and 120 days, traded or not.</span></div></div>
        <figcaption>Portfolio, Eric’s real holdings, sits apart from all three.</figcaption>`,
    control: () => `<div class="tablebox"><table class="ctl"><thead><tr><th>Automation</th><th>Armed by</th><th>Default</th><th>Stopped by</th></tr></thead><tbody>
        ${[
          ['Grok Scout', 'Repository variable SCOUT_ENABLED', 'Off unless set', 'The variable'],
          ['Automatic admission', 'automation.lead_admission, with an expiry', 'Off', 'Admission off · project stop'],
          ['Paid API research', 'A key, a model, prices, a budget', 'Not configured', 'Desk-wide pause · model hold'],
          ['Scheduled research', 'research.unattended_enabled', 'Off', 'Desk-wide pause'],
          ['Pilot runner', 'Eric enables the task and enrolls projects', 'Task disabled', 'Project stop'],
          ['Paper mandate', 'autonomous_paper_loop and an authority ≤ 30 days', 'Off', 'Mandate off · project stop · any decision of his'],
          ['Trader’s Paper Book', 'trader.book and trader.rules', 'Unset', 'Desk-wide pause'],
          ['Exit quotes', 'Monitoring per project, or exit_quotes_auto', 'Off', 'Monitoring off'],
          ['Contract forensics', 'contracts.enabled and compute caps', 'Off', 'The setting'],
          ['Wallet sync', 'ALCHEMY_API_KEY and a wallet he adds', 'No wallet', 'Removing the key or wallet']
        ].map((r) => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td class="off">${esc(r[2])}</td><td>${esc(r[3])}</td></tr>`).join('')}
        </tbody></table></div>`,
    next: () => `<ul class="openlist">${A.open.map(([t, d, e]) => { const l = evLink(e); return `<li><i class="dash" aria-hidden="true"></i><b>${esc(t)}</b><p>${esc(d)}</p><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a></li>`; }).join('')}</ul>`
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
  function renderMap(init) {
    document.body.style.overflow = 'hidden';
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
    const counts = (key, val) => A.nodes.filter((n) => n[key] === val).length;

    app.innerHTML = `<div class="mapview" id="mapview">
      <div class="viewport" id="vp"><div class="stage" id="stage" style="width:${STAGE_W}px;height:${STAGE_H}px">
        ${lanes}${bands}
        <svg class="edges" width="${STAGE_W}" height="${STAGE_H}" aria-hidden="true"><defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z"/></marker></defs>${edges}</svg>
        ${nodes}</div></div>
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
      <div class="panel viewtoggle" role="group" aria-label="View"><button data-view="map" aria-pressed="true">Map</button><button data-view="list" aria-pressed="false">List</button></div>
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
    if (narrow()) setView('list');

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
        ${n.gates ? `<h4>What has to be true</h4><ul class="gates">${n.gates.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
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
      mv.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
    }

    /* events */
    mv.addEventListener('click', (e) => {
      const t = e.target.closest('button, a'); if (!t) { if (!moved && e.target.closest('#vp') && (S.sel)) select(null); return; }
      if (t.classList.contains('node')) { if (moved) return; select(t.dataset.id === S.sel ? null : t.dataset.id); return; }
      if (t.closest('#maplist') && t.dataset.id) { select(t.dataset.id); return; }
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
    if (init.flow) startFlow(init.flow, init.step);
    else if (init.node && byId[init.node]) select(init.node, { smooth: false });
    else paint();
    return () => { document.removeEventListener('keydown', onKey); removeEventListener('resize', onResize); };
  }

  route();
})();
