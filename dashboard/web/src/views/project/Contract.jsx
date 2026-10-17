// The Contract section (#/project/<id>/contract; DESIGN_AND_IA_BLUEPRINT.md
// §3.3, split out of Market): the token's identity (status, official website,
// CoinGecko listing, every chain and contract on record, candidates, the
// evidence and the DefiLlama binding; ?open=identity brings it into view),
// the identity form (every asset, not only the first), then GoPlus's contract
// checks for every screened contract as saved. Drawing it never screens,
// fetches or writes; Save identity is the one write. Nothing is ever called
// safe: an absent flag reads "No", an unanswered check "—".
import { useRef, useState } from 'react';
import { Clock, Copy, Plus, Trash2 } from 'lucide-react';
import { fmtDate, fmtDateTime, toast, copyText } from '../../../../public/ui.js';
import { identityOf } from '../../../../public/brief-model.js';
import { contractChipModel, contractChecks, shortAddr } from '../../../../public/watchlist-model.js';
import { api, refresh } from '../../lib/desk.js';
import { SecurityAuditStrip } from '../../components/ui/SecurityAuditStrip.jsx';
import { Panel, Fold, KV, None, ExtLink, enc } from './kit.jsx';
import '../../styles/record.css';

const words = (s) => (s === null || s === undefined || s === '' ? '' : String(s).replace(/_/g, ' '));
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const chainWords = (id) => String(id || '').replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase()).trim();

// A copy button for one address, named for its chain.
function CopyAddr({ address, label }) {
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm btn-icon"
      aria-label={label ? `Copy the ${label} contract address` : 'Copy the contract address'}
      title={address}
      onClick={() => copyText(address)}
    >
      <Copy size={13} aria-hidden="true" />
    </button>
  );
}

function Addr({ address, label }) {
  return (
    <span className="ct-addr">
      <span className="l2-mono ct-full">{address}</span>
      <CopyAddr address={address} label={label} />
    </span>
  );
}

// ---- the DefiLlama binding ------------------------------------------------------------

// fundamentals.js states in words (watchlist-model.js FUND_STATE).
const FUND_STATE = { unmapped: 'No DefiLlama entity is bound to this project', identity_pending: 'Identity pending: nothing is fetched until it is confirmed', never_run: 'Not fetched yet', pending: 'Not fetched yet', disabled: 'DefiLlama is turned off in settings', unavailable: 'The saved figures could not be read' };
// A refresh outcome that says the binding itself is wrong (fundamentals.js).
const BINDING_PROBLEMS = ['not_found', 'scope_mismatch', 'entity_mismatch', 'unidentified'];

function DefiLlama({ d }) {
  const id = (d.project && d.project.identity) || {};
  const f = d.fundamentals && typeof d.fundamentals === 'object' ? d.fundamentals : null;
  const b = (id.defillama && typeof id.defillama === 'object' ? id.defillama : null) || (f && f.binding) || null;
  if (!b) return <span>{FUND_STATE.unmapped}</span>;
  const meaning = f && f.binding && f.binding.slug === b.slug ? f.binding.scope_meaning : null;
  const lf = f && f.last_refresh_failure;
  const problem = lf && BINDING_PROBLEMS.includes(lf.outcome) ? lf : null;
  const stateNote = f && f.state !== 'unmapped' && FUND_STATE[f.state] ? FUND_STATE[f.state] : null;
  return (
    <span className="ct-dl">
      <span><span className="l2-mono">{b.slug}</span>{` · ${b.scope}${meaning ? ` (${meaning})` : ''}`}</span>
      {b.verified_at ? <span className="faint">{` · verified ${fmtDate(b.verified_at)}${b.verified_by ? ` by ${b.verified_by}` : ''}`}</span> : null}
      {b.source_url ? <span>{' · '}<ExtLink href={b.source_url}>{b.source_url}</ExtLink></span> : null}
      {b.note ? <span className="muted">{` · ${b.note}`}</span> : null}
      {stateNote ? <span className="faint">{` · ${stateNote}`}</span> : null}
      {problem ? <span className="rc-err">{` · Binding problem (${words(problem.outcome)})${problem.error ? `: ${problem.error}` : ''}`}</span> : null}
    </span>
  );
}

// ---- the identity form ------------------------------------------------------------------

// The assets the form starts from: the identity's own, else (a pending
// identity keeps none) its first candidate's, so a save never drops them.
function startAssets(id) {
  const cand = (Array.isArray(id.candidates) ? id.candidates : [])[0] || {};
  if (Array.isArray(id.assets) && id.assets.length) return id.assets;
  return Array.isArray(cand.assets) ? cand.assets : [];
}

// The request body, or the reason it cannot be sent. Every row with a chain
// is sent (the earlier form sent only the first, and none when its Chain was
// blank, which erased every other contract); an asset left as it was keeps
// its standard and note.
function identityBody({ website, cg, rows, ev, evNote }) {
  const kept = rows.map((r) => ({ ...r, chain: r.chain.trim(), contract: r.contract.trim() })).filter((r) => r.chain || r.contract);
  if (kept.some((r) => !r.chain)) return { error: 'Give the chain of every contract address.' };
  const seen = new Set();
  const assets = [];
  for (const r of kept) {
    const k = `${r.chain.toLowerCase()}|${r.contract.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const a = { chain: r.chain, contract_address: r.contract || null };
    const o = r.orig;
    if (o && String(o.chain || '').toLowerCase() === r.chain.toLowerCase() && String(o.contract_address || '') === r.contract) {
      if (o.standard) a.standard = o.standard;
      if (o.note) a.note = o.note;
    }
    assets.push(a);
  }
  return {
    value: {
      official_website: website.trim() || null,
      coingecko_id: cg.trim() || null,
      assets,
      evidence: ev.trim() ? [{ url: ev.trim(), note: evNote.trim() || null, kind: 'user' }] : [],
    },
  };
}

function IdentityForm({ d, pid, onSaved }) {
  const id = (d.project && d.project.identity) || {};
  const cand = (Array.isArray(id.candidates) ? id.candidates : [])[0] || {};
  const start = startAssets(id);
  const nextKey = useRef(start.length + 1);
  const [website, setWebsite] = useState(id.official_website || '');
  const [cg, setCg] = useState(id.coingecko_id || cand.coingecko_id || '');
  const [rows, setRows] = useState(() => (start.length
    ? start.map((a, i) => ({ key: i, chain: a.chain || '', contract: a.contract_address || '', orig: a }))
    : [{ key: 0, chain: '', contract: '', orig: null }]));
  const [ev, setEv] = useState('');
  const [evNote, setEvNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const hadContracts = start.some((a) => a && (a.chain || a.contract_address));
  const setRow = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const save = async () => {
    if (busy) return;
    const body = identityBody({ website, cg, rows, ev, evNote });
    if (body.error) { setProblem(body.error); return; }
    if (!body.value.assets.length && hadContracts && !window.confirm(`Remove every contract from this identity? Its chains and contract addresses are taken off the record.${body.value.coingecko_id ? '' : ' Without a CoinGecko listing ID the identity is then pending: no prices or holdings use it.'}`)) return;
    setProblem(null);
    setBusy(true);
    try {
      const r = await api.post(`/api/projects/${enc(pid)}/identity`, body.value);
      toast(r && r.identity_status === 'verified' ? 'Identity verified and bound' : 'Saved; identity still pending (needs website, token binding and evidence)');
      await refresh();
      onSaved();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="l2-form ct-form" data-key="identity-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <label>
        <span>Official website</span>
        <input className="input" type="url" name="official_website" value={website} placeholder="https://…" onChange={(e) => setWebsite(e.target.value)} />
      </label>
      <label>
        <span>CoinGecko listing ID</span>
        <input className="input" name="coingecko_id" value={cg} placeholder="CoinGecko listing ID" spellCheck={false} autoComplete="off" onChange={(e) => setCg(e.target.value)} />
      </label>
      <fieldset className="ct-assets">
        <legend>Chains and contracts</legend>
        {rows.map((r, i) => (
          <div key={r.key} className="ct-asset-row" data-key={`identity-asset-${i}`}>
            <label>
              <span>Chain</span>
              <input className="input" value={r.chain} placeholder="chain" aria-label={`Chain, row ${i + 1}`} spellCheck={false} autoComplete="off" onChange={(e) => setRow(r.key, { chain: e.target.value })} />
            </label>
            <label>
              <span>Contract / mint</span>
              <input className="input" value={r.contract} placeholder="contract / mint" aria-label={`Contract / mint, row ${i + 1}`} spellCheck={false} autoComplete="off" onChange={(e) => setRow(r.key, { contract: e.target.value })} />
            </label>
            <button
              type="button"
              className="btn btn-sm btn-ghost btn-icon"
              aria-label={`Remove row ${i + 1}${r.chain ? ` (${r.chain})` : ''}`}
              data-key={`identity-remove-${i}`}
              onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
        <div className="l2-actions">
          <button type="button" className="btn btn-sm" data-key="identity-add-asset" onClick={() => setRows((rs) => [...rs, { key: nextKey.current++, chain: '', contract: '', orig: null }])}>
            <Plus size={13} aria-hidden="true" />Add a contract
          </button>
        </div>
      </fieldset>
      <label>
        <span>Evidence URL</span>
        <input className="input" type="url" name="evidence_url" value={ev} placeholder="https://… official page that names the token" onChange={(e) => setEv(e.target.value)} />
      </label>
      <label>
        <span>Evidence note</span>
        <input className="input" name="evidence_note" value={evNote} placeholder="What it confirms" onChange={(e) => setEvNote(e.target.value)} />
      </label>
      {problem ? <p className="l2-err" role="alert">{problem}</p> : null}
      <div className="l2-actions">
        <button type="submit" className="btn btn-sm btn-primary" data-key="identity-save" disabled={busy} aria-busy={busy || undefined}>{busy ? 'Saving…' : 'Save identity'}</button>
      </div>
    </form>
  );
}

// ---- 1. the token identity ------------------------------------------------------------

function IdentityPanel({ d, row, pid }) {
  const [formGen, setFormGen] = useState(0);
  const id = (d.project && d.project.identity) || {};
  const idm = identityOf(d, row);
  const verified = id.status === 'verified';
  const cg = id.coingecko_id || null;
  const candidates = Array.isArray(id.candidates) ? id.candidates : [];
  const evidence = Array.isArray(id.evidence) ? id.evidence : [];
  return (
    <section className="l2-panel ct-identity" data-key="pb-identity" tabIndex={-1} aria-labelledby="ct-identity-h">
      <header className="l2-panel-head">
        <h2 className="l2-panel-t" id="ct-identity-h" title="The token this project is bound to, the evidence for it, and the DefiLlama entity bound to it.">Token identity</h2>
        <span className={`badge ${verified ? 'is-ok' : 'is-warn'}`}>{verified ? 'Verified' : cap(words(id.status)) || 'Unknown'}</span>
      </header>
      <div className="l2-panel-body">
        {verified
          ? <p className="rc-line">Verified: bound to the token below. Prices and holdings use this identity.</p>
          : <p className="note note-warn" role="note">{`Pending: ${(id.unknowns || []).join(' ')} No prices or holdings use a pending identity.`}</p>}
        <KV
          label="Identity"
          rows={[
            ['Official website', idm.website ? <ExtLink href={idm.website}>{idm.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}</ExtLink> : 'Not confirmed'],
            ['CoinGecko listing', cg ? <ExtLink href={`https://www.coingecko.com/en/coins/${enc(cg)}`}>{cg}</ExtLink> : 'None on record'],
            idm.native ? ['Native coin', 'The chain\'s own coin: no contract'] : null,
            ['DefiLlama', <DefiLlama d={d} />, null, true],
          ]}
        />
        <section className="rc-sub" aria-labelledby="ct-chains-h">
          <h3 id="ct-chains-h" className="rc-h3">Chains and contracts</h3>
          {idm.chains.length ? (
            <ul className="l2-rows ct-chains">
              {idm.chains.map((c) => (
                <li key={c.label} data-key={`ct-chain-${c.label}`}>
                  <span className="ct-chain">{c.label}</span>
                  {c.addresses.length
                    ? c.addresses.map((a) => <Addr key={a} address={a} label={c.label} />)
                    : <span className="faint">No contract address on record</span>}
                </li>
              ))}
            </ul>
          ) : <None>{idm.native ? 'Native coin: no contract.' : 'No chain or contract on record.'}</None>}
        </section>
        {candidates.length ? (
          <section className="rc-sub" aria-labelledby="ct-cand-h">
            <h3 id="ct-cand-h" className="rc-h3">Candidates</h3>
            <ul className="l2-rows ct-chains">
              {candidates.map((c, i) => (
                <li key={`${c.coingecko_id || 'none'}-${i}`}>
                  <span>{c.coingecko_id ? <>{'CoinGecko '}<ExtLink href={`https://www.coingecko.com/en/coins/${enc(c.coingecko_id)}`}>{c.coingecko_id}</ExtLink></> : 'No CoinGecko listing ID'}</span>
                  {(c.assets || []).map((a, k) => (
                    <span key={`${a.chain}-${a.contract_address || k}`} className="ct-cand-asset">
                      <span className="ct-chain">{chainWords(a.chain)}</span>
                      {a.contract_address ? <Addr address={a.contract_address} label={chainWords(a.chain)} /> : <span className="faint">No contract address</span>}
                    </span>
                  ))}
                  {c.note ? <span className="muted">{c.note}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <section className="rc-sub" aria-labelledby="ct-ev-h">
          <h3 id="ct-ev-h" className="rc-h3">Evidence</h3>
          {evidence.length ? (
            <ul className="l2-list ct-ev">
              {evidence.map((e, i) => (
                <li key={`${e.url}-${i}`}>
                  <ExtLink href={e.url}>{e.url}</ExtLink>
                  {e.note ? ` — ${e.note}` : ''}
                  <span className="faint">{` (checked ${fmtDate(e.checked_at)})`}</span>
                </li>
              ))}
            </ul>
          ) : <None>No identity evidence URL recorded.</None>}
        </section>
        <Fold dataKey="identity-edit" title="Edit the identity" note="Verified needs an official website, a token binding (a CoinGecko listing ID or a contract) and at least one evidence URL. Evidence is added to what is on record; nothing is removed from it.">
          <IdentityForm key={formGen} d={d} pid={pid} onSaved={() => setFormGen((g) => g + 1)} />
        </Fold>
      </div>
    </section>
  );
}

// ---- 2. the contract checks -----------------------------------------------------------

// The screen in brief as the index carries it (screening.js summary), from
// the project record's saved screen: used when the index row has none.
function summaryOf(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    state: s.state,
    reason: s.reason || null,
    native_chain: s.native_chain,
    fetched_at: s.fetched_at || null,
    age_hours: typeof s.age_hours === 'number' ? s.age_hours : null,
    contracts: (Array.isArray(s.contracts) ? s.contracts : []).map((x) => (x.status === 'ok'
      ? { chain: x.chain, label: x.label, address: x.address, status: 'ok', mint: x.checks && x.checks.mint, blacklist: x.checks ? (x.family === 'solana' ? x.checks.freeze : x.checks.blacklist) : undefined, proxy: x.family === 'solana' ? null : x.checks && x.checks.proxy, family: x.family, sell_tax_pct: x.taxes ? x.taxes.sell_pct : null, severe: x.severe, watch: x.watch, unknown: x.unknown }
      : { chain: x.chain, label: x.label, address: x.address, status: x.status, reason: x.reason || null })),
    alerts: Array.isArray(s.alerts) ? s.alerts : [],
    last_error: s.last_attempt && s.last_attempt.outcome !== 'ok' ? s.last_attempt.error : null,
  };
}

// The screen's state in words (watchlist-model.js contractStrip's words).
const SCREEN_WORDS = { ok: 'Screened', stale: 'Stale', pending: 'Not screened yet', disabled: 'Screening off', unsupported: 'Not screenable', unavailable: 'Screen failed', native_chain: 'Native coin', no_contract: 'None on record', identity_pending: 'Identity pending' };

function ContractBlock({ c }) {
  return (
    <div className="cc-contract ct-contract" data-key={`ct-contract-${c.address || c.label}`}>
      <div className="cc-head">
        <span className="cc-chain">{c.label}</span>
        {c.address ? <Addr address={c.address} label={c.label} /> : null}
        {c.status === 'ok' ? <span className="faint" title="GoPlus Security">{`Checked ${fmtDateTime(c.checked_at)}${c.partial ? ' · partial answer' : ''}`}</span> : null}
      </div>
      {c.status !== 'ok' ? <p className="faint rc-line">{c.reason || cap(words(c.status)) || 'Not screened'}</p> : (
        <dl className="cc-rows">
          {c.rows.map((r) => <div key={r.key} className={`cc-row is-${r.state} lvl-${r.level}`}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}
          {c.facts.map(([k, v, full]) => <div key={k} className="cc-row is-fact"><dt>{k}</dt><dd className={full ? 'mono' : undefined} title={full || undefined}>{v}</dd></div>)}
        </dl>
      )}
      {c.status === 'ok' && c.unknown.length ? <p className="cc-unknown"><span className="ct-k">No answer: </span>{c.unknown.join(' · ')}</p> : null}
      {c.notes && c.notes.length ? <p className="faint rc-line">{c.notes.join(' · ')}</p> : null}
    </div>
  );
}

function ContractChecks({ d, row }) {
  const sc = d.screening && typeof d.screening === 'object' ? d.screening : null;
  const m = contractChipModel((row && row.screening) || summaryOf(sc));
  const checks = contractChecks(sc);
  const state = sc ? sc.state : null;
  const nativeId = Boolean(d.project && d.project.identity && d.project.identity.native_chain === true);
  let lead = null;
  if (!sc) lead = nativeId ? 'Native coin: no contract to screen.' : 'No contract screen on record.';
  else if (state === 'native_chain') lead = 'Native coin: no contract to screen.';
  else if (state === 'identity_pending') lead = 'Identity pending: nothing is screened until it is confirmed.';
  else if (state === 'no_contract') lead = 'No contract screen on record.';
  else if (!checks && !(Array.isArray(sc.contracts) && sc.contracts.length)) lead = sc.reason || 'No contract screen on record.';
  const word = (m.status && m.status.word) || SCREEN_WORDS[state] || (state ? cap(words(state)) : null);
  const warn = (m.status && m.status.tone === 'warn') || state === 'stale' || state === 'unavailable';
  const alerts = checks ? checks.alerts : (sc && Array.isArray(sc.alerts) ? sc.alerts.map((a) => ({ at: a.at, label: a.chain, address: a.address, words: a.words })) : []);
  const unscreened = !checks && sc && Array.isArray(sc.contracts) ? sc.contracts : [];
  const la = sc && sc.last_attempt ? sc.last_attempt : null;
  const quiet = state === 'native_chain' || state === 'identity_pending' || state === 'no_contract';
  return (
    <Panel id="ct-checks" title="Contract checks" sub="GoPlus Security" note="Every check GoPlus Security answered for each screened contract, as saved; never fetched on this page.">
      <div className="ct-status">
        {word ? <span className={`badge${warn ? ' is-warn' : ''}`} title={(m.status && m.status.title) || (sc && sc.reason) || undefined}>{word}</span> : null}
        {m.age ? (
          <span className={`cc-age${m.stale ? ' is-stale' : ''}`} title={m.ageTitle} aria-label={`Screened by GoPlus ${m.age} ago${m.stale ? ', stale' : ''}`}>
            {m.stale ? <Clock size={12} aria-hidden="true" /> : null}<span aria-hidden="true">{`GoPlus ${m.age}`}</span>
          </span>
        ) : null}
      </div>
      {lead ? <p className="rc-line">{lead}</p> : null}
      {lead && sc && sc.reason && quiet ? <p className="faint rc-line">{sc.reason}</p> : null}
      {!quiet && m.items.length ? <SecurityAuditStrip model={m} /> : null}
      {alerts.length ? (
        <ul className="cc-alerts ct-alerts" aria-label="Contract changes">
          {alerts.map((a, i) => (
            <li key={`${a.at}-${a.address}-${i}`}>
              <strong>Changed</strong>{`: ${fmtDateTime(a.at)} · ${a.label || ''} `}<span className="mono" title={a.address}>{shortAddr(a.address)}</span>{`: ${a.words}`}
            </li>
          ))}
        </ul>
      ) : null}
      {checks && checks.contracts.length ? (
        <div className="cchecks">
          {checks.contracts.map((c, i) => <ContractBlock key={`${c.label}-${c.address}-${i}`} c={c} />)}
        </div>
      ) : null}
      {!quiet && unscreened.length ? (
        <div className="cchecks">
          {/* No saved answer yet: each contract with why it is not screened. */}
          {unscreened.map((c, i) => <ContractBlock key={`${c.label}-${c.address}-${i}`} c={{ label: c.label || c.chain || 'chain?', address: c.address, status: c.status === 'ok' || !c.status ? 'not_screened' : c.status, reason: c.reason || null }} />)}
        </div>
      ) : null}
      {la || (sc && sc.next_attempt_at) ? (
        <KV
          label="Screening runs"
          rows={[
            la ? ['Last attempt', `${fmtDateTime(la.at)}${la.trigger ? ` · ${words(la.trigger)}` : ''} · ${la.outcome === 'ok' ? 'answered' : words(la.outcome)}${la.error ? `: ${la.error}` : ''}`, null, true] : null,
            sc && sc.next_attempt_at ? ['Next attempt', `from ${fmtDateTime(sc.next_attempt_at)}`] : null,
          ]}
        />
      ) : null}
    </Panel>
  );
}

export default function Contract({ d, row, pid }) {
  const r = row || {};
  return (
    <div className="l2-stack ct">
      <IdentityPanel d={d} row={r} pid={pid} />
      <ContractChecks d={d} row={r} />
    </div>
  );
}
