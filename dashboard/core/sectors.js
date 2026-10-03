'use strict';
// A small sector taxonomy for the watchlist. A project has one primary sector
// (yours to edit) plus free tags. The sector is not the scoring profile: the
// profile decides which rubric categories apply; the sector is how you group
// and filter. A sector can suggest a profile, never the other way round silently.
// New projects are suggested the current profile versions (@2, the thirteen
// category grades of cr-research-prompt@5); a project saved with an @1 profile
// keeps its record, and its new research uses the current version of that
// profile (rubrics.currentProfileRef).

const SECTORS = [
  { id: 'defi', label: 'DeFi', suggests_profile: 'general-token@2' },
  { id: 'payments', label: 'Payments / PayFi', suggests_profile: 'payfi-credit@2' },
  { id: 'infrastructure', label: 'Infrastructure', suggests_profile: 'network-infrastructure@2' },
  { id: 'ai_data', label: 'AI / Data', suggests_profile: 'network-infrastructure@2' },
  { id: 'gaming', label: 'Gaming', suggests_profile: 'general-token@2' },
  { id: 'other', label: 'Other', suggests_profile: 'general-token@2' },
];

const BY_ID = new Map(SECTORS.map((s) => [s.id, s]));

const PROFILE_DEFAULT_SECTOR = {
  'payfi-credit@1': 'payments',
  'network-infrastructure@1': 'infrastructure',
  'general-token@1': 'other',
  'payfi-credit@2': 'payments',
  'network-infrastructure@2': 'infrastructure',
  'general-token@2': 'other',
};

function isSector(id) {
  return BY_ID.has(id);
}

function sectorLabel(id) {
  return BY_ID.has(id) ? BY_ID.get(id).label : 'Unclassified';
}

// Accepts an id or a label ("PayFi", "AI/Data", "infra") and returns the id, or null.
function parseSector(text) {
  if (!text) return null;
  const s = String(text).trim().toLowerCase();
  if (BY_ID.has(s)) return s;
  const plain = s.replace(/[^a-z]/g, '');
  const aliases = {
    defi: 'defi', lending: 'defi', dex: 'defi', amm: 'defi', yield: 'defi',
    payments: 'payments', payment: 'payments', payfi: 'payments', paymentspayfi: 'payments', credit: 'payments', rwa: 'payments',
    infrastructure: 'infrastructure', infra: 'infrastructure', l1: 'infrastructure', l2: 'infrastructure', layer1: 'infrastructure', layer2: 'infrastructure', oracle: 'infrastructure', depin: 'infrastructure', network: 'infrastructure',
    ai: 'ai_data', aidata: 'ai_data', data: 'ai_data', ml: 'ai_data',
    gaming: 'gaming', games: 'gaming', game: 'gaming', gamefi: 'gaming',
    other: 'other',
  };
  return aliases[plain] || null;
}

function normalizeSector(input, { source = 'owner', fallbackProfile = null } = {}) {
  if (input && typeof input === 'object') {
    const primary = parseSector(input.primary);
    if (!primary) return null;
    const tags = [...new Set((input.tags || []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 12);
    return { primary, tags, source: input.source || source, updated_at: new Date().toISOString() };
  }
  const primary = parseSector(input) || (fallbackProfile ? PROFILE_DEFAULT_SECTOR[fallbackProfile] || 'other' : null);
  if (!primary) return null;
  return { primary, tags: [], source: parseSector(input) ? source : 'suggested', updated_at: new Date().toISOString() };
}

module.exports = { SECTORS, PROFILE_DEFAULT_SECTOR, isSector, sectorLabel, parseSector, normalizeSector };
