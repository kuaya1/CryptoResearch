'use strict';
// Builds the dashboard's view of the workspace from the files. The index is a
// derived cache (dashboard/index/index.json) that can be deleted and rebuilt at
// any time; the files under projects/, portfolio/ and market-data/ are the record.

const { readJson, jsonText, listDir, readJsonLines, fileInfo } = require('./fsx');
const { listProjects, getProject } = require('./projects');
const { loadReports, isEligible, reportSortKey, EVIDENCE_TAGS, VERDICTS, effectiveIssues } = require('./reports');
const { compareProject, diffReports, latestByProvider } = require('./compare');
const { checkModelTotal } = require('./scoring');
const { gradeAssessment } = require('./rubrics');
const { readConsistent, readConsistentDetailed, replaceFile } = require('./ops');
const notes = require('./notes');
const portfolio = require('./portfolio');
const market = require('./market');
const inbox = require('./inbox');
const requests = require('./requests');
const { ymdInTz, addDays, daysBetween, isYmd } = require('./dates');
const { PROVIDERS, PROVIDER_LABELS } = require('./workspace');
const { SECTORS, sectorLabel } = require('./sectors');

const INDEX_REL = 'dashboard/index/index.json';

// Each report is graded with the rubric version it declares (audit F05).
function gradeOf(ws, r) {
  const g = gradeAssessment(ws, r.assessment);
  return { grade: g, model_total: g ? checkModelTotal(g, r.assessment.model_reported_overall_score, ws.settings.grading.discrepancy_tolerance) : null };
}

function compactGrade(g) {
  if (!g) return null;
  return { status: g.status, display: g.display, label: g.label, value: g.value, low: g.low, high: g.high, coverage_pct: g.coverage_pct, reason: g.reason || null, rubric: g.rubric || null, rubric_status: g.rubric_status || null };
}

// The project's verified website, which tells the evidence checks which
// sources are its own.
const siteOf = (project) => (project && project.identity && project.identity.status === 'verified' ? project.identity.official_website || null : null);

// Evidence checks (evidence.js), in brief for lists: never a score change.
function evidenceBrief(a, project) {
  const e = require('./evidence').evidenceChecks(a, { officialWebsite: siteOf(project) });
  return { flagged: e.flagged_claims, high: e.high, medium: e.medium, low: e.low, critical: e.critical_claims, summary: e.summary };
}

function reportSummary(ws, r, project = null) {
  if (r.broken) return { report_id: r.report_id, broken: true, error: r.error };
  const a = r.assessment;
  const { grade, model_total } = gradeOf(ws, r);
  const ex = r.record.extraction || {};
  const issues = effectiveIssues(ex.issues);
  return {
    report_id: r.report_id,
    provider: r.meta.provider,
    analysis_at: a.analysis_at,
    imported_at: r.meta.imported_at,
    format: a.source_format,
    model_version: a.model_version,
    horizon: a.horizon,
    rubric_version: a.rubric_version,
    sector_profile: a.sector_profile,
    verdict: a.verdict,
    eligible: isEligible(r),
    excluded_reason: a.eligibility && a.eligibility.excluded ? a.eligibility.reason : null,
    grade: compactGrade(grade),
    unscored: unscoredParts(grade, a),
    model_total: model_total ? { status: model_total.status, message: model_total.message } : null,
    evidence_confidence: a.diagnostic_scores ? a.diagnostic_scores.evidence_confidence || null : null,
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    ambiguous: (ex.ambiguous || []).length,
    corrections: r.corrections.length,
    corrected_fields: a.corrected_fields || [],
    needs_text: Boolean(a.needs_text),
    citation_integrity: r.integrity ? { status: r.integrity.status, counts: r.integrity.counts } : null,
    provenance: r.provenance || null,
    claims: (a.claims || []).length,
    sources: (a.sources || []).length,
    top_risks: topRisks(a),
    position: require('./position').compactContext(a),
    evidence: evidenceBrief(a, project),
    // The category grades in brief (counts only, never a total), under the
    // scoring profile the report declares.
    scorecard: require('./thesis').scorecardBrief(a, ws.rubrics.profiles[a.sector_profile] || null),
    chart_phase: a.chart_cycle ? a.chart_cycle.phase : null,
  };
}

// What a new research run on this project would use: the current published
// version of its scoring profile, the prompt that profile calls for and the
// active grading rubric. A run freezes these when it is created; earlier runs
// and reports keep their own.
function researchContract(ws, project) {
  const ref = require('./rubrics').currentProfileRef(ws, project.sector_profile);
  const profile = ws.rubrics.profiles[ref] || null;
  return {
    sector_profile: ref || null,
    project_profile: project.sector_profile || null,
    prompt_version: require('./prompts').promptVersionFor({ recipe: require('./position').RECIPE_ID }, profile),
    rubric_version: ws.rubrics.activeRef,
    category_grades: profile ? profile.diagnostic_categories.filter((c) => c.applicable !== false).length : null,
  };
}

// The weighted parts a withheld grade is missing, each with the model's own
// note on why (its missing_data), so a preview can say why in plain words.
// Nothing is filled in: these parts have no value.
function unscoredParts(grade, a) {
  if (!grade || grade.status !== 'withheld') return null;
  return (grade.missing || []).map((m) => {
    const s = (a.investment_components || {})[m.id];
    const note = s ? s.missing_data || s.rationale || null : null;
    return { label: m.label, status: m.status, note: note ? String(note).slice(0, 280) : null };
  });
}

// The two highest downside scores (higher = more risk), for compact previews.
function topRisks(a) {
  return Object.entries(a.risk_scores || {})
    .map(([id, s]) => ({ id, status: s && s.status, value: s && s.status === 'scored' ? s.value : s && s.status === 'range' ? s.high : null, low: s && s.low, high: s && s.high }))
    .filter((x) => x.value !== null && x.value !== undefined)
    .sort((x, y) => y.value - x.value)
    .slice(0, 2);
}

// A job waiting for its assistant is normal for a few minutes after a run
// starts; after this long it is worth a line in the review queue.
const WAITING_NOTICE_MINUTES = 15;

function minutesText(min) {
  if (min < 120) return `${min} minutes`;
  if (min < 2880) return `${Math.round(min / 60)} hours`;
  return `${Math.round(min / 1440)} days`;
}

// Research that needs Eric, per model: a failed job; an API call that may
// have been billed with no answer saved (high: money may be counted); an
// assistant that stopped working on its job; a job waiting for its assistant
// for more than a few minutes. Each opens the project's research runs.
function researchAttention(ws, p, researchState, now) {
  const out = [];
  if (!researchState) return out;
  const research = require('./research');
  const action = `#/project/${p.project_id}/research`;
  for (const prov of PROVIDERS) {
    const job = researchState.providers[prov];
    if (!job) continue;
    const who = PROVIDER_LABELS[prov];
    const item = (kind, severity, title, detail) => out.push({ kind, severity, project_id: p.project_id, title: `${p.name}: ${title}`, detail, action });
    if (job.state === 'failed') item('research_failed', 'medium', `${who} research job failed`, job.error || 'See the research run for details.');
    else if (job.state === 'uncertain') item('research_uncertain', 'high', `${who} API call needs a check`, 'The request may have been sent and billed, and no answer was saved. Check the provider\'s usage page, then reconcile it or retry.');
    else if (job.state === 'unconfigured') {
      const since = Date.parse(job.updated_at || job.run_created_at || '');
      const min = Number.isNaN(since) ? null : Math.round((now - since) / 60000);
      if (min !== null && min > WAITING_NOTICE_MINUTES) {
        item('research_waiting', 'medium', `${who} research is waiting for you`, ws.hosted
          ? `Its prompt has been ready for ${minutesText(min)}. Ask ${who} to do its waiting research through its desk connection, or paste the prompt into ${who} and import the answer.`
          : `Its prompt has been ready for ${minutesText(min)}. Paste it into ${who} and import the answer.`);
      }
    } else if (research.isAssistantJob(job)) {
      const act = research.assistantActivity(job, { created_at: job.run_created_at }, now);
      if (act && act.interrupted) item('research_interrupted', 'medium', `${job.mode === 'cowork' ? 'Cowork' : who} stopped working on its research`, `No activity for ${minutesText(act.idle_minutes)} and no report saved. Ask it to resume (its prompt and any draft are kept), or restart it.`);
    }
  }
  return out;
}

function resolveHeadline(ws, project, reports, journal) {
  const h = project.headline;
  if (!h) return null;
  if (h.type === 'report') {
    const r = reports.find((x) => x.report_id === h.report_id);
    if (!r || r.broken) return { type: 'missing', message: `The selected report ${h.report_id} was not found.` };
    return { type: 'report', selected_at: h.selected_at, note: h.note || null, ...reportSummary(ws, r, project) };
  }
  const e = journal.find((x) => x.entry_id === h.entry_id);
  if (!e) return { type: 'missing', message: `The selected decision ${h.entry_id} was not found.` };
  return { type: 'decision', selected_at: h.selected_at, entry_id: e.entry_id, decision: e.decision, conviction: e.conviction, text: e.text, created_at: e.created_at };
}

function eventDate(d) {
  if (!d || typeof d !== 'string') return { date: null, precision: 'unknown' };
  if (isYmd(d.slice(0, 10))) return { date: d.slice(0, 10), precision: 'day' };
  if (/^\d{4}-\d{2}$/.test(d)) return { date: `${d}-01`, precision: 'month' };
  return { date: null, precision: 'unknown', raw: d };
}

function marketFor(ws, project, latest) {
  const id = project.identity && project.identity.status === 'verified' ? project.identity.coingecko_id : null;
  if (!id) return null;
  const obs = latest.assets ? latest.assets[id] : null;
  if (!obs) return { coingecko_id: id, status: 'missing' };
  const asOf = obs.source_last_updated_at || obs.fetched_at;
  const t = Date.parse(asOf);
  const valid = typeof obs.price_usd === 'number' && Number.isFinite(obs.price_usd) && obs.price_usd > 0 && !Number.isNaN(t);
  const age = Number.isNaN(t) ? null : Math.round((Date.now() - t) / 60000);
  const logo = market.logoFile(ws, id);
  const volChange = valid ? market.volumeChange24h(ws, id, obs) : null;
  return {
    coingecko_id: id,
    ...obs,
    sparkline_7d: Array.isArray(obs.sparkline_7d) ? obs.sparkline_7d : null,
    logo_url: logo ? `/api/logos/${id}` : null,
    rank_source_label: obs.rank_source === 'coingecko' ? 'CoinGecko market-cap rank' : obs.rank_source === 'fictional-demo' ? 'FICTIONAL demo rank' : obs.rank_source || null,
    volume_change_24h_pct: volChange ? volChange.pct : null,
    volume_change_basis: volChange ? `vs. stored observation ${volChange.hours} h earlier (${volChange.compared_with})` : 'needs a stored observation from about 24 hours earlier',
    vs_btc: valid ? require('./cycle').assetVsBtc(latest, obs) : null,
    as_of: asOf,
    age_minutes: age,
    status: !valid ? 'invalid' : age !== null && age > ws.settings.freshness.price_stale_minutes ? 'stale' : 'fresh',
  };
}

function buildIndexRaw(ws, { light = false, now = Date.now() } = {}) {
  const started = Date.now();
  const today = ymdInTz(new Date(now));
  const settings = ws.settings;
  const latestMarket = market.readLatest(ws);
  // CoinGecko IDs the last price refresh asked for and did not get back.
  const notReturned = new Set(market.freshness(ws, now).missing_ids || []);
  const pf = portfolio.computePortfolio(ws, { market: latestMarket, now });
  const held = new Map(pf.positions.filter((p) => !p.closed && p.project_id).map((p) => [p.project_id, p]));
  const projectsOut = [];
  const calendar = [];
  const evidence = { claims: [], contradictions: [], shared_sources: [], unresolved: [], disputes: [], stale_claims: 0 };
  const attention = [];
  const staleClaimDays = settings.freshness.claim_stale_days;

  for (const p of listProjects(ws)) {
    if (p.broken) {
      projectsOut.push({ project_id: p.project_id, name: p.project_id, broken: true, error: p.error });
      attention.push({ kind: 'broken_record', severity: 'high', project_id: p.project_id, title: `Project record ${p.project_id} could not be read`, detail: p.error });
      continue;
    }
    const reports = loadReports(ws, p.project_id);
    const journal = notes.loadJournal(ws, p.project_id);
    const events = notes.loadEvents(ws, p.project_id);
    const comp = compareProject(ws, reports);
    const headline = resolveHeadline(ws, p, reports, journal);
    const latest = latestByProvider(reports);
    const providers = {};
    for (const prov of PROVIDERS) {
      if (latest[prov]) {
        providers[prov] = reportSummary(ws, latest[prov], p);
        continue;
      }
      // A PDF-only report is not comparable, but it exists: say "needs text",
      // not "no research".
      const textless = reports
        .filter((r) => !r.broken && r.meta.provider === prov && (r.assessment.needs_text || r.assessment.source_format === 'pdf'))
        .sort((a, b) => reportSortKey(b).localeCompare(reportSortKey(a)))[0];
      providers[prov] = textless ? { ...reportSummary(ws, textless, p), needs_text: true, latest_eligible: false } : null;
    }
    const good = reports.filter((r) => !r.broken);
    const lastReport = good.sort((a, b) => reportSortKey(b).localeCompare(reportSortKey(a)))[0] || null;
    const openEvents = events.filter((e) => e.status === 'open');
    const nextReview = openEvents.filter((e) => e.type === 'review' && e.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date))[0] || null;
    const mkt = marketFor(ws, p, latestMarket);
    const position = held.get(p.project_id) || null;
    const archived = p.status === 'archived';

    // Calendar: your events plus catalysts, unlocks and invalidators from the latest reports.
    for (const e of events) {
      calendar.push({ source: 'you', project_id: p.project_id, project_name: p.name, event_id: e.event_id, type: e.type, title: e.title, date: e.due_date, precision: e.due_date ? 'day' : 'unknown', status: e.status, note: e.note, alert: e.alert || null, overdue: e.status === 'open' && Boolean(e.due_date) && e.due_date < today });
      if (e.status === 'open' && e.type === 'alert' && e.alert && mkt && typeof mkt.price_usd === 'number') {
        const hit = e.alert.kind === 'price_below' ? mkt.price_usd < e.alert.threshold_usd : mkt.price_usd > e.alert.threshold_usd;
        if (hit) attention.push({ kind: 'alert', severity: 'high', project_id: p.project_id, title: `${p.name}: price ${e.alert.kind === 'price_below' ? 'below' : 'above'} $${e.alert.threshold_usd}`, detail: `Last price $${mkt.price_usd} as of ${mkt.as_of}${mkt.status === 'stale' ? ' (stale)' : ''}. ${e.title}` });
      }
    }
    for (const prov of PROVIDERS) {
      const r = latest[prov];
      if (!r) continue;
      for (const c of r.assessment.catalysts || []) {
        // A position-cycle report gives a window instead of a single date.
        const d = eventDate(c.date || c.window_start);
        const windowed = !c.date && Boolean(c.window_start);
        calendar.push({ source: 'report', provider: prov, report_id: r.report_id, project_id: p.project_id, project_name: p.name, type: c.kind === 'unlock' ? 'unlock' : 'catalyst', title: c.title, date: d.date, precision: windowed ? 'window' : c.date_precision || d.precision, window_end: windowed ? c.window_end || null : null, certainty: c.certainty || null, status: c.status || null, note: c.kind === 'unlock' ? 'Potential liquid supply, not demonstrated selling.' : null });
      }
      const pc = r.assessment.position_context;
      if (pc && pc.timing && pc.timing.next_review_date) {
        calendar.push({ source: 'report', provider: prov, report_id: r.report_id, project_id: p.project_id, project_name: p.name, type: 'suggested_review', title: `${PROVIDER_LABELS[prov]} suggests a review`, date: pc.timing.next_review_date, precision: 'day', status: null, note: pc.timing.review_trigger || 'A model\'s suggestion, not your review calendar.' });
      }
      for (const u of r.assessment.unlocks || []) {
        const d = eventDate(u.date);
        const amount = [u.amount_tokens ? `${Number(u.amount_tokens).toLocaleString('en-US')} tokens` : null, u.pct_of_supply ? `${u.pct_of_supply}% of supply` : null].filter(Boolean).join(', ');
        calendar.push({ source: 'report', provider: prov, report_id: r.report_id, project_id: p.project_id, project_name: p.name, type: 'unlock', title: `Unlock${amount ? `: ${amount}` : ''}${u.recipient_class ? ` (${u.recipient_class})` : ''}`, date: d.date, precision: d.precision, status: null, note: 'Potential liquid supply, not demonstrated selling.' });
      }
      for (const inv of r.assessment.invalidators || []) {
        calendar.push({ source: 'report', provider: prov, report_id: r.report_id, project_id: p.project_id, project_name: p.name, type: 'invalidator', title: inv.text, date: null, precision: 'unknown', status: 'monitoring' });
      }
    }

    // Evidence across the latest report from each provider.
    const reviews = notes.loadClaimReviews(ws, p.project_id);
    if (!light) {
      for (const prov of PROVIDERS) {
        const r = latest[prov];
        if (!r) continue;
        const urls = new Map(r.assessment.sources.map((s) => [s.source_id, s]));
        for (const c of r.assessment.claims) {
          const rev = reviews[`${r.report_id}#${c.claim_id}`] || {};
          const asOf = c.as_of && !Number.isNaN(Date.parse(c.as_of)) ? c.as_of : null;
          const stale = asOf ? daysBetween(asOf.slice(0, 10), today) > staleClaimDays : false;
          if (stale) evidence.stale_claims++;
          evidence.claims.push({
            project_id: p.project_id,
            project_name: p.name,
            provider: prov,
            report_id: r.report_id,
            claim_id: c.claim_id,
            text: c.text,
            evidence_tag: c.evidence_tag,
            evidence_tag_raw: c.evidence_tag_raw,
            metric_id: c.metric_id,
            value: c.value,
            unit: c.unit,
            period: c.period,
            definition: c.definition,
            as_of: c.as_of,
            limitation: c.limitation,
            stale,
            sources: c.source_ids.map((id) => urls.get(id)).filter(Boolean).map((s) => ({ source_id: s.source_id, url: s.url, title: s.title, source_type: s.source_type })),
            dashboard_check: rev.dashboard_check || { status: 'not_checked' },
            corroboration: rev.corroboration || { status: 'none' },
          });
        }
        for (const q of r.assessment.unresolved_questions || []) evidence.unresolved.push({ project_id: p.project_id, project_name: p.name, provider: prov, report_id: r.report_id, question: q });
      }
      for (const c of comp.claim_conflicts) {
        for (const pair of c.pairs) {
          if (pair.kind === 'agreement') continue;
          evidence.contradictions.push({ project_id: p.project_id, project_name: p.name, metric_id: c.metric_id, ...pair });
        }
      }
      for (const s of comp.shared_sources.shared) evidence.shared_sources.push({ project_id: p.project_id, project_name: p.name, ...s });
      for (const d of notes.loadDisputes(ws, p.project_id)) evidence.disputes.push({ project_id: p.project_id, project_name: p.name, ...d });
    }

    // Attention items for this project.
    if (!archived) {
      for (const e of openEvents) {
        if (e.type !== 'review' || !e.due_date) continue;
        const days = daysBetween(today, e.due_date);
        if (days < 0) attention.push({ kind: 'review_overdue', severity: 'high', project_id: p.project_id, title: `${p.name}: review overdue since ${e.due_date}`, detail: e.title });
        else if (days === 0) attention.push({ kind: 'review_due', severity: 'medium', project_id: p.project_id, title: `${p.name}: review due today`, detail: e.title });
        else if (days <= 7) attention.push({ kind: 'review_upcoming', severity: 'low', project_id: p.project_id, title: `${p.name}: review in ${days} day${days === 1 ? '' : 's'} (${e.due_date})`, detail: e.title });
      }
      // A model's suggested review date that is close and not yet on your calendar.
      const suggested = PROVIDERS
        .map((prov) => {
          const pc = latest[prov] && latest[prov].assessment.position_context;
          return pc && pc.timing && pc.timing.next_review_date ? { prov, date: pc.timing.next_review_date } : null;
        })
        .filter(Boolean)
        .sort((x, y) => x.date.localeCompare(y.date))[0];
      if (suggested) {
        const days = daysBetween(today, suggested.date);
        const covered = openEvents.some((e) => e.type === 'review' && e.due_date && e.due_date <= suggested.date);
        if (!covered && days <= 7) {
          attention.push({ kind: 'review_suggested', severity: 'low', project_id: p.project_id, title: `${p.name}: ${PROVIDER_LABELS[suggested.prov]} suggested a review ${days < 0 ? `on ${suggested.date}, which has passed` : days === 0 ? 'for today' : `in ${days} day${days === 1 ? '' : 's'} (${suggested.date})`}`, detail: 'A model\'s suggestion, not your review calendar. Add it as a review if you agree.' });
        }
      }
      if (comp.flagged.length) {
        attention.push({ kind: 'disagreement', severity: 'medium', project_id: p.project_id, title: `${p.name}: models disagree on ${comp.flagged.length} item${comp.flagged.length === 1 ? '' : 's'}`, detail: comp.flagged.map((f) => `${f.label} (${f.spread})`).join(', ') });
      }
      for (const prov of PROVIDERS) {
        const s = providers[prov];
        if (!s) continue;
        if (s.model_total && s.model_total.status === 'mismatch') attention.push({ kind: 'grade_mismatch', severity: 'medium', project_id: p.project_id, title: `${p.name}: ${PROVIDER_LABELS[prov]} total disagrees with the calculated grade`, detail: s.model_total.message });
        if (s.errors || s.ambiguous) attention.push({ kind: 'extraction', severity: 'medium', project_id: p.project_id, title: `${p.name}: ${PROVIDER_LABELS[prov]} report needs review`, detail: `${s.errors} error(s), ${s.ambiguous} ambiguous field(s) in the extraction.` });
        if (s.needs_text) attention.push({ kind: 'needs_text', severity: 'medium', project_id: p.project_id, title: `${p.name}: ${PROVIDER_LABELS[prov]} PDF needs a text copy`, detail: 'The PDF is preserved; scores cannot be read from it offline.' });
      }
      if (p.identity.status !== 'verified') attention.push({ kind: 'identity', severity: 'low', project_id: p.project_id, title: `${p.name}: token identity pending`, detail: (p.identity.unknowns || []).join(' ') });
      // A verified binding CoinGecko does not return is probably a wrong ID: the
      // project never gets a price. Flagged, never changed automatically.
      if (p.identity.status === 'verified' && p.identity.coingecko_id && notReturned.has(p.identity.coingecko_id)) attention.push({ kind: 'identity_price', severity: 'medium', project_id: p.project_id, title: `${p.name}: CoinGecko returned no price for "${p.identity.coingecko_id}"`, detail: 'The last price refresh asked CoinGecko for this ID and got nothing back, so the project has no price. The ID may be wrong: find the project on CoinGecko, check that the contract it lists is the one on file, and correct the binding.' });
      if (position && lastReport && lastReport.assessment.analysis_at && daysBetween(String(lastReport.assessment.analysis_at).slice(0, 10), today) > settings.freshness.report_stale_days) {
        attention.push({ kind: 'stale_research', severity: 'medium', project_id: p.project_id, title: `${p.name}: newest research is ${daysBetween(String(lastReport.assessment.analysis_at).slice(0, 10), today)} days old and you hold a position`, detail: 'Consider a new dated report. Prices never change stored grades.' });
      }
    }

    let researchState = null;
    try {
      researchState = require('./research').researchStateFor(ws, p.project_id);
    } catch (_) { /* optional */ }
    let changes = null;
    if (!light) {
      try {
        const d = require('./digest').changesSince(ws, p.project_id, { latestMarket });
        changes = { since: d.since, cursor_source: d.cursor_source, item_count: d.item_count, new_reports: d.new_reports.length, price_change_pct: d.price ? d.price.change_pct : null };
      } catch (_) { /* optional */ }
    }
    const sector = p.sector && p.sector.primary ? { ...p.sector, label: sectorLabel(p.sector.primary) } : { primary: null, label: 'Unclassified', tags: [], source: null };
    if (!archived) attention.push(...researchAttention(ws, p, researchState, now));
    projectsOut.push({
      project_id: p.project_id,
      name: p.name,
      symbol: p.symbol,
      status: p.status,
      sector,
      sector_profile: p.sector_profile,
      identity_status: p.identity.status,
      identity_unknowns: p.identity.unknowns || [],
      coingecko_id: p.identity.status === 'verified' ? p.identity.coingecko_id : null,
      official_website: p.identity.official_website,
      on_watchlist: Boolean(p.watchlist && p.watchlist.on_watchlist),
      held: Boolean(position),
      position: position ? { quantity: position.quantity, value_usd: position.value_usd, price_status: position.price.status } : null,
      headline,
      providers,
      research: researchState,
      changes,
      review: p.review || null,
      report_count: good.length,
      last_report_at: lastReport ? lastReport.assessment.analysis_at || lastReport.meta.imported_at : null,
      comparison: { comparable_providers: comp.comparability.comparable_providers, reasons: comp.comparability.reasons, flagged: comp.flagged, rows: comp.rows.map((r) => ({ section: r.section, id: r.id, label: r.label, spread: r.spread, spread_flag: r.spread_flag, applicable: r.applicable })) },
      next_review: nextReview ? { date: nextReview.due_date, title: nextReview.title, overdue: nextReview.due_date < today } : null,
      open_events: openEvents.length,
      market: mkt,
      created_at: p.created_at,
      updated_at: p.updated_at,
    });
  }

  for (const e of notes.loadEvents(ws, 'portfolio')) {
    calendar.push({ source: 'you', project_id: null, project_name: 'Portfolio', event_id: e.event_id, type: e.type, title: e.title, date: e.due_date, precision: 'day', status: e.status, note: e.note, overdue: e.status === 'open' && Boolean(e.due_date) && e.due_date < today });
    if (e.status === 'open' && e.type === 'review' && e.due_date && e.due_date < today) attention.push({ kind: 'review_overdue', severity: 'high', project_id: null, title: `Portfolio review overdue since ${e.due_date}`, detail: e.title });
  }

  // Workspace-level attention.
  const mf = market.freshness(ws, now);
  if (['stale', 'stale_failed', 'failed'].includes(mf.freshness)) {
    attention.push({ kind: 'market_stale', severity: 'medium', project_id: null, title: mf.last_success_at ? `Prices are stale (last update ${mf.age_minutes} min ago)` : 'Prices have never been fetched', detail: mf.note || (mf.last_error ? `Last error: ${mf.last_error}` : 'Values shown use the last valid observation.'), action: '#/settings?tab=activity' });
  }
  const inboxSt = inbox.inboxStatus(ws);
  for (const f of inboxSt.in_inbox) {
    if (['failed', 'needs_project', 'prompt', 'provider_mismatch'].includes(f.status)) attention.push({ kind: 'import_failed', severity: 'high', project_id: null, title: `Import needs attention: ${f.key}`, detail: f.error });
  }
  const pending = requests.pendingRequests(ws);
  for (const r of pending) {
    const ageMin = Math.round((now - Date.parse(r.waiting_since)) / 60000);
    if (ageMin > 5) attention.push({ kind: 'request_pending', severity: ageMin > 120 ? 'high' : 'medium', project_id: null, title: `Cowork request pending for ${ageMin} min: ${r.action || r.file}`, detail: 'Not saved yet. It is applied when the dashboard is open or the hourly task runs.' });
  }
  const jobsState = require('./jobs').readJobState(ws);
  const lastSched = jobsState.runner && jobsState.runner.last_scheduler_run_at;
  if (lastSched && now - Date.parse(lastSched) > 3 * 3600000) {
    attention.push({ kind: 'scheduler_quiet', severity: 'medium', project_id: null, title: `The hourly scheduled task last ran ${Math.round((now - Date.parse(lastSched)) / 3600000)} h ago`, detail: 'The PC may have been asleep or off, or the task was removed. Check: node dashboard/cli.js schedule status' });
  }
  for (const f of pf.limits.flags || []) attention.push({ kind: 'limit', severity: f.severity === 'warn' ? 'medium' : 'low', project_id: null, title: f.message, detail: 'Limits only flag. Nothing is traded.' });
  for (const w of pf.warnings) {
    if (['shortfall', 'in_transit', 'transfer_mismatch', 'unmatched_transfer_in', 'ambiguous_transfer_id', 'transfer_quarantined', 'bridge_unmatched_asset'].includes(w.kind)) attention.push({ kind: `portfolio_${w.kind}`, severity: 'medium', project_id: null, title: 'Portfolio record needs attention', detail: w.message });
  }
  const blocked = require('./ops').blockedState(ws);
  if (blocked) attention.push({ kind: 'writes_blocked', severity: 'high', project_id: null, title: 'Saving is blocked until a failed check is resolved', detail: `${blocked.reason} (op ${blocked.op_id}). Run: node dashboard/cli.js recover --status` });
  let researchProviders = null;
  try {
    const research = require('./research');
    researchProviders = research.providerStatus(ws);
    const skipped = research.dueSchedules(ws, now);
    if (skipped.length && !settings.research.unattended_enabled) attention.push({ kind: 'research_refresh_due', severity: 'low', project_id: null, title: `Research refresh due for ${skipped.length} project(s)`, detail: 'Scheduled research is configured but unattended paid calls are off. Start it yourself, or turn on unattended research with a budget.' });
  } catch (_) { /* optional */ }
  // One ranked queue: highest impact first, the same item never listed twice.
  const sev = { high: 0, medium: 1, low: 2 };
  const seenAttention = new Set();
  const ranked = [];
  for (const a of attention.sort((x, y) => sev[x.severity] - sev[y.severity])) {
    const k = `${a.kind}|${a.project_id || ''}|${a.title}`;
    if (seenAttention.has(k)) continue;
    seenAttention.add(k);
    if (!a.action) a.action = a.project_id ? `#/project/${a.project_id}` : ['import_failed', 'request_pending'].includes(a.kind) ? '#/imports?tab=inbox' : a.kind.startsWith('portfolio_') || a.kind === 'limit' ? '#/portfolio' : a.kind === 'market_stale' || a.kind === 'scheduler_quiet' || a.kind === 'writes_blocked' ? '#/settings' : null;
    ranked.push(a);
  }
  attention.length = 0;
  attention.push(...ranked);

  calendar.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  const findings = readJson(ws.abs('logs/review-findings.json'), null);

  return {
    sectors: SECTORS,
    research: researchProviders ? { providers: researchProviders, budget: settings.research.budget, unattended_enabled: Boolean(settings.research.unattended_enabled), spend: (() => { try { return require('./research').spendSoFar(ws); } catch (_) { return null; } })() } : null,
    schema_version: 'cr.index.v1',
    generated_at: new Date().toISOString(),
    build_ms: Date.now() - started,
    today,
    timezone: 'America/New_York',
    workspace: { name: ws.meta.name, kind: ws.kind, workspace_id: ws.meta.workspace_id, root: ws.root },
    settings,
    rubrics: {
      grading: ws.rubrics.grading,
      labels: ws.rubrics.labels,
      profiles: Object.values(ws.rubrics.profiles).map((pr) => ({ profile_ref: pr.profile_ref, title: pr.title, applies_to: pr.applies_to, diagnostic_categories: pr.diagnostic_categories, research_sections: pr.research_sections, economics_fields: pr.economics_fields })),
      evidence_tags: EVIDENCE_TAGS,
      verdicts: VERDICTS,
    },
    projects: projectsOut,
    market_context: require('./cycle').summary(ws, now),
    horizon_policy: require('./position').policy(ws),
    portfolio: pf,
    calendar,
    evidence,
    attention,
    review_findings: findings,
    freshness: {
      market: mf,
      jobs: jobsState,
      market_tracked: market.trackedIds(ws),
    },
    imports: {
      inbox: inboxSt,
      requests_pending: pending,
      requests_recent: requests.recentResults(ws),
      recent_operations: readJsonLines(ws.abs('logs/operations.jsonl'), { tail: 25 }).reverse(),
    },
  };
}

function writeIndex(ws, index) {
  replaceFile(ws, ws.abs(INDEX_REL), jsonText(index));
  return INDEX_REL;
}

function rebuildIndex(ws) {
  const index = buildIndex(ws);
  writeIndex(ws, index);
  return index;
}

// Readers see one coherent generation of the records (audit F04/V2-001), or
// get READ_BUSY / READ_INTERRUPTED / READ_UNSAFE: never a mixed result.
function buildIndex(ws, opts = {}) {
  const r = readConsistentDetailed(ws, () => buildIndexRaw(ws, opts), opts.waitMs === undefined ? {} : { waitMs: opts.waitMs });
  r.value.read_generation = { generation: r.generation, op_id: r.op_id };
  return r.value;
}

function projectDetail(ws, id, opts = {}) {
  return readConsistent(ws, () => projectDetailRaw(ws, id), opts.waitMs === undefined ? {} : { waitMs: opts.waitMs });
}

function projectDetailRaw(ws, id) {
  const project = getProject(ws, id);
  const reports = loadReports(ws, id);
  const journal = notes.loadJournal(ws, id);
  const comp = compareProject(ws, reports);
  const latestMarket = market.readLatest(ws);
  const pf = portfolio.computePortfolio(ws, { market: latestMarket });
  const reportsOut = reports
    .map((r) => {
      if (r.broken) return { report_id: r.report_id, broken: true, error: r.error };
      const { grade, model_total } = gradeOf(ws, r);
      return {
        report_id: r.report_id,
        meta: r.meta,
        assessment: r.assessment,
        extraction: r.record.extraction ? { ...r.record.extraction, issues: effectiveIssues(r.record.extraction.issues) } : r.record.extraction,
        corrections: r.corrections,
        integrity: r.integrity,
        provenance: r.provenance,
        grade,
        model_total,
        eligible: isEligible(r),
        evidence: require('./evidence').evidenceChecks(r.assessment, { officialWebsite: siteOf(project) }),
      };
    })
    .sort((a, b) => String((b.assessment && b.assessment.analysis_at) || (b.meta && b.meta.imported_at) || '').localeCompare(String((a.assessment && a.assessment.analysis_at) || (a.meta && a.meta.imported_at) || '')));
  const history = {};
  const diffs = {};
  for (const prov of PROVIDERS) {
    const list = reports.filter((r) => !r.broken && r.meta.provider === prov).sort((a, b) => reportSortKey(a).localeCompare(reportSortKey(b)));
    history[prov] = list.map((r) => reportSummary(ws, r, project));
    diffs[prov] = [];
    for (let i = 1; i < list.length; i++) diffs[prov].push(diffReports(list[i - 1], list[i]));
  }
  const prompts = {};
  for (const prov of PROVIDERS) {
    const rel = `projects/${id}/prompts/${prov}.md`;
    const info = fileInfo(ws.abs(rel));
    prompts[prov] = info ? { rel, updated_at: new Date(info.mtimeMs).toISOString(), bytes: info.size } : null;
  }
  const research = require('./research');
  return {
    prompt_files: require('./prompts').listPromptFiles(ws, id),
    research: { runs: research.listRuns(ws, id), providers: research.providerStatus(ws) },
    changes: require('./digest').changesSince(ws, id, { latestMarket }),
    sector: project.sector ? { ...project.sector, label: sectorLabel(project.sector.primary) } : null,
    sectors: SECTORS,
    project,
    profile: ws.rubrics.profiles[project.sector_profile] || null,
    research_contract: researchContract(ws, project),
    headline: resolveHeadline(ws, project, reports, journal),
    reports: reportsOut,
    comparison: comp,
    history,
    diffs,
    journal,
    events: notes.loadEvents(ws, id),
    disputes: notes.loadDisputes(ws, id),
    claim_reviews: notes.loadClaimReviews(ws, id),
    conviction: notes.readConvictionNote(ws, id),
    prompts,
    market: marketFor(ws, project, latestMarket),
    market_context: require('./cycle').summary(ws),
    horizon_policy: require('./position').policy(ws),
    // A closed position (sold to zero) is history, not a holding.
    position: pf.positions.find((p) => p.project_id === id && !p.closed) || null,
    portfolio_method: pf.method,
  };
}

module.exports = { INDEX_REL, buildIndex, writeIndex, rebuildIndex, projectDetail, reportSummary };
