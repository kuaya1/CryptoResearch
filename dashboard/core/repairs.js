'use strict';
// One-time repairs of known records on the online desk, run when it starts
// (hosted.js). Each repair is named, fixes one record through the normal write
// paths (archiveProject, updateIdentity, updateProjectFields: validated,
// journaled and verified like any other save), and runs only while its target
// is exactly in the state it was written for, so it can never touch anything
// else. Each is recorded once in .cr/repairs.json, applied or skipped with the
// reason and the files it changed, and never runs again. A repair whose target
// project does not exist (Eric's PC workspace, a fresh desk) does nothing and
// records nothing. A repair that fails is logged and tried again at the next
// start; it never stops the desk.
//
// The facts a repair writes are the ones its evidence entries name, checked
// on the date they give. Nothing is inferred.

const { runOp } = require('./ops');
const { readJson, listDir } = require('./fsx');
const projects = require('./projects');
const research = require('./research');

const LEDGER_REL = '.cr/repairs.json';

const CMC_AVANTIS = new Set(['https://coinmarketcap.com/currencies/avantis/', 'https://coinmarketcap.com/currencies/avantis']);
const CMC_REASON = 'Duplicate of Veranta (formerly Avantis): added from the CoinMarketCap link coinmarketcap.com/currencies/avantis, which the Add project form took as the official website. CoinGecko lists \'avantis\' as Veranta (AVNT). Nothing was deleted; unarchive it on the project page if this is wrong.';

const SANDBOX_SITE = 'https://www.sandbox.game/en/';
const SAND_CONTRACT = '0x3845badade8e6dff049820680d1f14bd3903a5d0';

const relsOf = (out) => ((out && out.files) || []).map((f) => (typeof f === 'string' ? f : f.rel)).filter(Boolean);

// check(ws, project): why the target is not in the state the repair was
// written for (it is then skipped), or null when it is. apply(ws, project):
// the repair itself, returning what it did and the files it changed.
const REPAIRS = [
  {
    // The dashboard's Add project form took a pasted CoinMarketCap link as the
    // official website and its host as the name; the project is Veranta
    // (formerly Avantis), which the desk already has.
    id: '2026-10-03-coinmarketcap-duplicate',
    target: 'coinmarketcap',
    check(ws, p) {
      const idn = p.identity || {};
      if (p.status === 'archived') return 'coinmarketcap is already archived';
      if (idn.status === 'verified') return 'coinmarketcap has a verified identity';
      if (!CMC_AVANTIS.has(idn.official_website)) return `coinmarketcap's website is ${idn.official_website || 'not set'}, not the CoinMarketCap Avantis page`;
      if (listDir(ws.abs('projects/coinmarketcap/reports'), { dirs: true }).length) return 'coinmarketcap has reports';
      // An archived project's queued job would still be sent to a paid API.
      if (research.openRunOf(ws, 'coinmarketcap')) return 'coinmarketcap has an open research run';
      const v = projects.loadProject(ws, 'veranta-formerly-avantis');
      if (!v) return 'veranta-formerly-avantis is not on the desk';
      if (!v.identity || v.identity.status !== 'verified') return 'veranta-formerly-avantis is not verified';
      if (v.identity.coingecko_id !== 'avantis') return `veranta-formerly-avantis is bound to CoinGecko "${v.identity.coingecko_id || 'none'}", not "avantis"`;
      return null;
    },
    apply(ws) {
      const out = projects.archiveProject(ws, 'coinmarketcap', CMC_REASON);
      return { message: 'archived coinmarketcap as a duplicate of veranta-formerly-avantis', files: relsOf(out) };
    },
  },
  {
    // Added from the dashboard with its website only, so it stayed pending
    // and never got a price.
    id: '2026-10-03-sandbox-identity',
    target: 'sandbox',
    check(ws, p) {
      const idn = p.identity || {};
      if (p.status === 'archived') return 'sandbox is archived';
      if (idn.status === 'verified') return `sandbox's identity is already verified${idn.coingecko_id ? ` (${idn.coingecko_id})` : ''}`;
      const elsewhere = (idn.candidates || []).some((c) => (c.coingecko_id && c.coingecko_id !== 'the-sandbox') || (c.assets || []).some((a) => a.contract_address && String(a.contract_address).toLowerCase() !== SAND_CONTRACT));
      if (idn.coingecko_id || elsewhere) return 'sandbox already has another CoinGecko ID or contract on file';
      if (projects.domainOf(idn.official_website || '') !== 'sandbox.game') return `sandbox's website is ${idn.official_website || 'not set'}, not sandbox.game`;
      const clash = projects.findDuplicates(ws, { coingecko_id: 'the-sandbox', assets: [{ chain: 'ethereum', contract_address: SAND_CONTRACT }], official_website: SANDBOX_SITE }, { excludeId: 'sandbox' }).strong;
      if (clash.length) return `${clash[0].project_id} already has that identity (${clash[0].reasons.join(', ')})`;
      return null;
    },
    apply(ws) {
      // The name first: run again after an interruption, both steps still fit.
      const files = relsOf(projects.updateProjectFields(ws, 'sandbox', { name: 'The Sandbox', symbol: 'SAND' }));
      const upd = projects.updateIdentity(ws, 'sandbox', {
        official_website: SANDBOX_SITE,
        coingecko_id: 'the-sandbox',
        assets: [{ chain: 'ethereum', contract_address: SAND_CONTRACT, standard: 'ERC-20' }],
        evidence: [
          { url: 'https://www.coingecko.com/en/coins/the-sandbox', note: `CoinGecko lists sandbox.game as the homepage of The Sandbox (SAND) and Ethereum contract ${SAND_CONTRACT} (checked 2026-10-03)`, kind: 'repair' },
          { url: `https://etherscan.io/token/${SAND_CONTRACT}`, note: 'Etherscan\'s SAND token page names sandbox.game as the official site (checked 2026-10-03)', kind: 'repair' },
        ],
      });
      files.push(...relsOf(upd));
      return { message: upd.identity_status === 'verified' ? 'identity verified: the-sandbox' : `identity still ${upd.identity_status}: ${upd.unknowns.join(' ')}`, files: [...new Set(files)] };
    },
  },
];

function readLedger(ws) {
  return readJson(ws.abs(LEDGER_REL), null) || { schema_version: 'cr.repairs.v1', repairs: {} };
}

function record(ws, entry) {
  return runOp(ws, { type: 'repair_record', summary: `Record repair ${entry.id}` }, (op) => {
    const doc = op.readJson(LEDGER_REL, null) || { schema_version: 'cr.repairs.v1', repairs: {} };
    doc.repairs = doc.repairs || {};
    doc.repairs[entry.id] = entry;
    op.writeJson(LEDGER_REL, doc);
  });
}

// Runs every repair not yet recorded. One log line per repair applied,
// skipped or failed; nothing for one already recorded or whose target is not here.
function runRepairs(ws, { log = () => {}, repairs = REPAIRS } = {}) {
  // Records changed here are attributed to the repair, not to a person.
  const rw = Object.create(ws, { actor: { value: 'repair', writable: true, enumerable: true } });
  const done = readLedger(ws).repairs || {};
  const results = [];
  for (const r of repairs) {
    if (done[r.id]) {
      results.push({ id: r.id, status: 'recorded_before' });
      continue;
    }
    const p = projects.loadProject(ws, r.target);
    if (!p) {
      results.push({ id: r.id, status: 'not_here' });
      continue;
    }
    let entry;
    try {
      const why = r.check(rw, p);
      if (why) {
        entry = { id: r.id, skipped_at: new Date().toISOString(), reason: why, files: [] };
      } else {
        const out = r.apply(rw, p);
        entry = { id: r.id, applied_at: new Date().toISOString(), reason: out.message, files: out.files };
      }
    } catch (err) {
      log(`Repair ${r.id}: failed (tried again at the next start): ${err.message}`);
      results.push({ id: r.id, status: 'failed', reason: err.message });
      continue;
    }
    const line = `Repair ${r.id}: ${entry.applied_at ? `applied (${entry.reason})` : `skipped: ${entry.reason}`}`;
    try {
      record(rw, entry);
      log(line);
    } catch (err) {
      // The next start finds the record already changed and skips it.
      log(`${line}; the note in ${LEDGER_REL} could not be saved: ${err.message}`);
    }
    results.push({ id: r.id, status: entry.applied_at ? 'applied' : 'skipped', reason: entry.reason, files: entry.files });
  }
  return results;
}

module.exports = { runRepairs, readLedger, REPAIRS, LEDGER_REL };
