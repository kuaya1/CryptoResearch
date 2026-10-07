-- CryptoResearch Explorer, schema 1 (2026-10-06).
--
-- A small, private mirror of research records for learning and comparison.
-- The desk's own Markdown/JSON records (on the PC, and the online desk on
-- Render) stay the record. This database only receives one-way exports from
-- the desk's Node backend and is read only by that backend. It holds no
-- research jobs, spend, prompts, portfolio, notes, secrets or backups.
--
-- Tables
--   projects         one row per project: stable ID, name, ticker, identity
--                    status, and the verified chain and contract where the
--                    desk has one
--   reports          one row per saved model report: model, research and save
--                    dates, horizon, prompt / rubric / profile versions, its
--                    revision lineage and the desk's calculated grade status
--   category_scores  one row per diagnostic category grade of a report (the
--                    13 categories of the @2 profiles, 11 under @1): a point,
--                    a range, unknown (no number) or not applicable. The six
--                    weighted investment components are NOT here: the report
--                    row keeps only the grade the desk calculates from them.
--   export_runs      one row per export: when it ran and what it changed
--
-- Meaning kept from the desk (dashboard/core/scoring.js):
--   status scored          a supported point score: score set, low/high null
--   status range           a supported range: low and high set, never a midpoint
--   status unknown         no number at all, with what is missing
--   status not_applicable  no number, with why it does not apply
--   Zero is a number like any other (the columns allow 0 to 100); unknown is
--   never stored as zero. The desk's rubric cr-grading@1 scores 1 to 100.
--   grade_status withheld  at least one weighted component is not scored: no
--                          grade, only the share of weight covered
--
-- Immutability: a report and its category scores never change once written.
-- The desk's evidence checks are read-time readings that can be refreshed on
-- a later export; they never change a score (triggers below).
--
-- Access: RLS is on for every table with no policies, and every privilege of
-- anon and authenticated (the publishable key, Supabase Auth users) is
-- revoked, so they can read and write nothing. service_role (the secret key,
-- held only by the desk's backend) may SELECT, and INSERT through
-- explorer_import(); it has no DELETE or TRUNCATE.

-- ---------------------------------------------------------------------------
-- projects

create table public.projects (
  project_id        text primary key
                      constraint projects_id_format check (project_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  dataset           text not null
                      constraint projects_dataset check (dataset in ('demo', 'desk')),
  name              text not null
                      constraint projects_name_present check (btrim(name) <> ''),
  ticker            text
                      constraint projects_ticker_present check (ticker is null or length(btrim(ticker)) between 1 and 24),
  identity_status   text not null
                      constraint projects_identity_status check (identity_status in ('verified', 'pending', 'ambiguous')),
  chain             text,
  contract_address  text,
  native_chain      boolean not null default false,
  first_exported_at timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint projects_id_dataset unique (project_id, dataset),
  -- A chain and contract are kept only for a verified identity; a contract
  -- always names its chain; a native coin has a chain and no contract.
  constraint projects_contract_verified check (identity_status = 'verified' or (chain is null and contract_address is null and not native_chain)),
  constraint projects_contract_chain check (contract_address is null or chain is not null),
  constraint projects_native_coin check (not native_chain or (chain is not null and contract_address is null))
);

-- One project per token contract.
create unique index projects_one_per_contract on public.projects (chain, contract_address) where contract_address is not null;

comment on table public.projects is 'CryptoResearch Explorer: one row per project, copied one way from the desk. dataset demo is fictional.';

-- ---------------------------------------------------------------------------
-- reports

create table public.reports (
  report_id           text primary key
                        constraint reports_id_format check (report_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$'),
  project_id          text not null,
  dataset             text not null,
  model               text not null
                        constraint reports_model check (model in ('claude', 'chatgpt', 'gemini')),
  model_version       text,
  research_run_id     text,
  research_date       date,
  saved_at            timestamptz not null,
  horizon_text        text,
  horizon_start       date,
  horizon_end         date,
  report_format       text,
  prompt_version      text,
  rubric_version      text,
  profile_version     text,
  verdict             text,
  -- Revision lineage: a revision names the earlier report of the same
  -- project and model that it revises; the earlier one stays as it was.
  revision_of         text,
  revision_kind       text
                        constraint reports_revision_kind check (revision_kind in ('format_fix', 'reassessment', 'new_evidence', 'other', 'not_stated')),
  revision_basis      text
                        constraint reports_revision_basis check (revision_basis in ('existing_evidence', 'new_sources', 'scores_unchanged')),
  revision_note       text,
  -- The desk's calculated investment grade (never the model's own total).
  grade_status        text not null
                        constraint reports_grade_status check (grade_status in ('firm', 'range', 'withheld', 'invalid_weights')),
  grade_value         numeric(7,4),
  grade_low           numeric(7,4),
  grade_high          numeric(7,4),
  grade_coverage_pct  numeric(5,2),
  grade_unscored      text[] not null default '{}',
  grade_reason        text,
  -- The desk's evidence checks, as read at export (refreshable; never a score).
  evidence_summary    text,
  evidence_coverage   text
                        constraint reports_evidence_coverage check (evidence_coverage in ('full', 'partial', 'none')),
  evidence_high       integer not null default 0 constraint reports_evidence_high check (evidence_high >= 0),
  evidence_medium     integer not null default 0 constraint reports_evidence_medium check (evidence_medium >= 0),
  evidence_low        integer not null default 0 constraint reports_evidence_low check (evidence_low >= 0),
  evidence_checked_at timestamptz,
  content_sha256      text not null
                        constraint reports_hash_format check (content_sha256 ~ '^[0-9a-f]{64}$'),
  exported_at         timestamptz not null default now(),
  constraint reports_project foreign key (project_id, dataset) references public.projects (project_id, dataset),
  constraint reports_lineage_key unique (report_id, project_id, model),
  constraint reports_revision_of foreign key (revision_of, project_id, model) references public.reports (report_id, project_id, model),
  constraint reports_revision_not_self check (revision_of <> report_id),
  constraint reports_revision_complete check ((revision_of is null) = (revision_kind is null) and (revision_of is null) = (revision_basis is null)),
  constraint reports_revision_note check (revision_of is not null or revision_note is null),
  constraint reports_grade_bounds check (
    (grade_value is null or grade_value between 0 and 100)
    and (grade_low is null or grade_low between 0 and 100)
    and (grade_high is null or grade_high between 0 and 100)
    and (grade_coverage_pct is null or grade_coverage_pct between 0 and 100)),
  constraint reports_grade_shape check (
    (grade_status = 'firm' and grade_value is not null and grade_low is null and grade_high is null and grade_coverage_pct = 100)
    or (grade_status = 'range' and grade_value is null and grade_low is not null and grade_high is not null and grade_low <= grade_high and grade_coverage_pct = 100)
    or (grade_status in ('withheld', 'invalid_weights') and grade_value is null and grade_low is null and grade_high is null)),
  constraint reports_withheld_says_why check (grade_status <> 'withheld' or cardinality(grade_unscored) > 0 or grade_reason is not null),
  -- The desk refuses an analysis time more than a day after the save.
  constraint reports_research_before_save check (research_date is null or research_date <= (saved_at at time zone 'UTC')::date + 1),
  constraint reports_horizon_order check (horizon_start is null or horizon_end is null or horizon_start < horizon_end)
);

create index reports_project on public.reports (project_id, dataset);
create index reports_revision on public.reports (revision_of, project_id, model) where revision_of is not null;
create index reports_model_saved on public.reports (model, saved_at desc);

comment on table public.reports is 'CryptoResearch Explorer: one row per saved model report. Immutable; a changed report is a new row with revision_of.';

-- ---------------------------------------------------------------------------
-- category_scores

create table public.category_scores (
  report_id       text not null
                    constraint category_scores_report references public.reports (report_id),
  category_id     text not null
                    constraint category_scores_id_format check (category_id ~ '^[a-z][a-z0-9_]{0,63}$'),
  category_label  text not null,
  position        smallint not null
                    constraint category_scores_position check (position between 1 and 50),
  status          text not null
                    constraint category_scores_status check (status in ('scored', 'range', 'unknown', 'not_applicable')),
  score           numeric(5,2),
  score_low       numeric(5,2),
  score_high      numeric(5,2),
  confidence      text
                    constraint category_scores_confidence check (confidence in ('high', 'medium', 'low')),
  evidence_refs   text[] not null default '{}',
  rationale       text,
  main_weakness   text,
  unknown_reason  text,
  evidence_flags  jsonb not null default '[]'
                    constraint category_scores_flags_array check (jsonb_typeof(evidence_flags) = 'array'),
  primary key (report_id, category_id),
  constraint category_scores_one_position unique (report_id, position),
  constraint category_scores_bounds check (
    (score is null or score between 0 and 100)
    and (score_low is null or score_low between 0 and 100)
    and (score_high is null or score_high between 0 and 100)),
  constraint category_scores_shape check (
    (status = 'scored' and score is not null and score_low is null and score_high is null)
    or (status = 'range' and score is null and score_low is not null and score_high is not null and score_low <= score_high)
    or (status in ('unknown', 'not_applicable') and score is null and score_low is null and score_high is null)),
  constraint category_scores_confidence_needs_score check (confidence is null or status in ('scored', 'range')),
  constraint category_scores_unknown_reason check (unknown_reason is null or status = 'unknown')
);

create index category_scores_category on public.category_scores (category_id, status);

comment on table public.category_scores is 'CryptoResearch Explorer: diagnostic category grades (never the six weighted components). Unknown has no number; zero is a number.';

-- ---------------------------------------------------------------------------
-- export_runs

create table public.export_runs (
  export_id          uuid primary key default gen_random_uuid(),
  dataset            text not null
                       constraint export_runs_dataset check (dataset in ('demo', 'desk')),
  source             text not null,
  adapter_version    text not null,
  started_at         timestamptz not null,
  finished_at        timestamptz not null,
  projects_inserted  integer not null default 0,
  projects_updated   integer not null default 0,
  projects_unchanged integer not null default 0,
  reports_inserted   integer not null default 0,
  reports_unchanged  integer not null default 0,
  reports_evidence_updated integer not null default 0,
  reports_refused    integer not null default 0,
  scores_inserted    integer not null default 0,
  refused            jsonb not null default '[]'
                       constraint export_runs_refused_array check (jsonb_typeof(refused) = 'array')
);

create index export_runs_finished on public.export_runs (finished_at desc);

comment on table public.export_runs is 'CryptoResearch Explorer: one row per export, written by explorer_import(). Append-only.';

-- ---------------------------------------------------------------------------
-- Immutability

-- Refuses any change to a stored report, category score or export record,
-- except a refresh of the desk's evidence readings on an unchanged report.
create function public.explorer_refuse_change() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  readings text[] := array['evidence_summary', 'evidence_coverage', 'evidence_high', 'evidence_medium', 'evidence_low', 'evidence_checked_at', 'evidence_flags'];
begin
  if tg_op = 'UPDATE' and tg_table_name in ('reports', 'category_scores') and (to_jsonb(new) - readings) = (to_jsonb(old) - readings) then
    return new;
  end if;
  raise exception 'CryptoResearch Explorer: % on % refused. Stored reports, scores and exports never change; a changed report is exported as a new report that names the one it revises.', tg_op, tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

create trigger reports_immutable before update or delete on public.reports
  for each row execute function public.explorer_refuse_change();
create trigger category_scores_immutable before update or delete on public.category_scores
  for each row execute function public.explorer_refuse_change();
create trigger export_runs_append_only before update or delete on public.export_runs
  for each row execute function public.explorer_refuse_change();

-- ---------------------------------------------------------------------------
-- The one write path: explorer_import(batch)
--
-- batch = { dataset: 'demo' | 'desk', source, adapter_version,
--           projects: [ { project_id, name, ticker, identity_status, chain,
--                         contract_address, native_chain } ],
--           reports:  [ { report_id, project_id, model, ..., category_scores: [ ... ] } ] }
--
-- One call is one transaction. Projects first: a project of the other
-- dataset fails the whole call (nothing is written). Then each report in its
-- own savepoint, so a report is written whole with its scores or not at all:
--   inserted          new report_id
--   unchanged         same report_id, same content (only evidence readings may refresh)
--   evidence_updated  same content; the desk's evidence readings changed
--   conflict          same report_id, different content: refused, nothing written
--   refused           a constraint failed (named in the result): nothing written
-- The content hash is computed here, from the values as this database stores
-- them, never taken from the caller.

create function public.explorer_import(batch jsonb) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  ds text := batch->>'dataset';
  started timestamptz := clock_timestamp();
  readings text[] := array['evidence_summary', 'evidence_coverage', 'evidence_high', 'evidence_medium', 'evidence_low', 'evidence_checked_at'];
  p jsonb;
  r jsonb;
  prow public.projects;
  existing public.projects;
  rrow public.reports;
  stored public.reports;
  canon jsonb;
  new_hash text;
  n int;
  outcome text;
  results jsonb := '[]';
  refused jsonb := '[]';
  c_pi int := 0; c_pu int := 0; c_pn int := 0;
  c_ri int := 0; c_rn int := 0; c_re int := 0; c_rr int := 0; c_si int := 0;
  run_id uuid;
  err_constraint text;
begin
  if ds is null or ds not in ('demo', 'desk') then
    raise exception 'batch.dataset must be demo or desk' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(batch->'projects') is distinct from 'array' or jsonb_typeof(batch->'reports') is distinct from 'array' then
    raise exception 'batch.projects and batch.reports must be arrays' using errcode = 'check_violation';
  end if;
  if coalesce(btrim(batch->>'source'), '') = '' or coalesce(btrim(batch->>'adapter_version'), '') = '' then
    raise exception 'batch.source and batch.adapter_version are required' using errcode = 'check_violation';
  end if;

  -- Projects: the desk's current identity (a project is not history; its
  -- reports are). A project of the other dataset is never touched.
  for p in select value from jsonb_array_elements(batch->'projects') loop
    prow := jsonb_populate_record(null::public.projects, p);
    prow.dataset := ds;
    prow.native_chain := coalesce(prow.native_chain, false);
    select * into existing from public.projects where project_id = prow.project_id;
    if not found then
      insert into public.projects (project_id, dataset, name, ticker, identity_status, chain, contract_address, native_chain)
      values (prow.project_id, ds, prow.name, prow.ticker, prow.identity_status, prow.chain, prow.contract_address, prow.native_chain);
      c_pi := c_pi + 1;
    elsif existing.dataset <> ds then
      raise exception 'Project % belongs to the % dataset; a % export never changes it.', prow.project_id, existing.dataset, ds
        using errcode = 'check_violation';
    elsif (existing.name, existing.ticker, existing.identity_status, existing.chain, existing.contract_address, existing.native_chain)
          is not distinct from (prow.name, prow.ticker, prow.identity_status, prow.chain, prow.contract_address, prow.native_chain) then
      c_pn := c_pn + 1;
    else
      update public.projects
         set name = prow.name, ticker = prow.ticker, identity_status = prow.identity_status, chain = prow.chain,
             contract_address = prow.contract_address, native_chain = prow.native_chain, updated_at = now()
       where project_id = prow.project_id;
      c_pu := c_pu + 1;
    end if;
  end loop;

  -- Reports, each whole or not at all.
  for r in select value from jsonb_array_elements(batch->'reports') loop
    begin
      rrow := jsonb_populate_record(null::public.reports, r);
      rrow.dataset := ds;
      rrow.grade_unscored := coalesce(rrow.grade_unscored, '{}');
      rrow.evidence_high := coalesce(rrow.evidence_high, 0);
      rrow.evidence_medium := coalesce(rrow.evidence_medium, 0);
      rrow.evidence_low := coalesce(rrow.evidence_low, 0);
      rrow.evidence_checked_at := clock_timestamp();
      if jsonb_typeof(coalesce(r->'category_scores', '[]')) <> 'array' then
        raise exception 'report %: category_scores must be an array', rrow.report_id using errcode = 'check_violation';
      end if;
      -- What the report says, as stored: every column except the bookkeeping
      -- and the evidence readings, with its category scores in category order.
      canon := (to_jsonb(rrow) - readings - 'content_sha256' - 'exported_at' - 'dataset')
        || jsonb_build_object('category_scores', coalesce((
             select jsonb_agg(to_jsonb(cs) - 'report_id' - 'evidence_flags' order by cs.category_id)
               from jsonb_populate_recordset(null::public.category_scores, coalesce(r->'category_scores', '[]')) cs), '[]'::jsonb));
      new_hash := encode(pg_catalog.sha256(convert_to(canon::text, 'UTF8')), 'hex');

      select * into stored from public.reports where report_id = rrow.report_id;
      if found then
        if stored.content_sha256 <> new_hash then
          c_rr := c_rr + 1;
          outcome := 'conflict';
          refused := refused || jsonb_build_object('report_id', rrow.report_id, 'status', 'conflict', 'stored_sha256', stored.content_sha256, 'new_sha256', new_hash,
            'reason', 'This report ID is already stored with different content. Reports never change: export the change as a new report that names this one in revision_of.');
          results := results || jsonb_build_object('report_id', rrow.report_id, 'status', outcome, 'stored_sha256', stored.content_sha256, 'new_sha256', new_hash);
          continue;
        end if;
        outcome := 'unchanged';
        if (stored.evidence_summary, stored.evidence_coverage, stored.evidence_high, stored.evidence_medium, stored.evidence_low)
             is distinct from (rrow.evidence_summary, rrow.evidence_coverage, rrow.evidence_high, rrow.evidence_medium, rrow.evidence_low) then
          update public.reports
             set evidence_summary = rrow.evidence_summary, evidence_coverage = rrow.evidence_coverage, evidence_high = rrow.evidence_high,
                 evidence_medium = rrow.evidence_medium, evidence_low = rrow.evidence_low, evidence_checked_at = rrow.evidence_checked_at
           where report_id = rrow.report_id;
          outcome := 'evidence_updated';
        end if;
        update public.category_scores x
           set evidence_flags = coalesce(nx.evidence_flags, '[]'::jsonb)
          from jsonb_populate_recordset(null::public.category_scores, coalesce(r->'category_scores', '[]')) nx
         where x.report_id = rrow.report_id and x.category_id = nx.category_id
           and x.evidence_flags is distinct from coalesce(nx.evidence_flags, '[]'::jsonb);
        get diagnostics n = row_count;
        if n > 0 then outcome := 'evidence_updated'; end if;
        if outcome = 'evidence_updated' then c_re := c_re + 1; else c_rn := c_rn + 1; end if;
        results := results || jsonb_build_object('report_id', rrow.report_id, 'status', outcome, 'content_sha256', new_hash);
        continue;
      end if;

      rrow.content_sha256 := new_hash;
      rrow.exported_at := now();
      insert into public.reports select (rrow).*;
      insert into public.category_scores (report_id, category_id, category_label, position, status, score, score_low, score_high,
                                          confidence, evidence_refs, rationale, main_weakness, unknown_reason, evidence_flags)
      select rrow.report_id, cs.category_id, cs.category_label, cs.position, cs.status, cs.score, cs.score_low, cs.score_high,
             cs.confidence, coalesce(cs.evidence_refs, '{}'), cs.rationale, cs.main_weakness, cs.unknown_reason, coalesce(cs.evidence_flags, '[]'::jsonb)
        from jsonb_populate_recordset(null::public.category_scores, coalesce(r->'category_scores', '[]')) cs;
      get diagnostics n = row_count;
      c_ri := c_ri + 1;
      c_si := c_si + n;
      results := results || jsonb_build_object('report_id', rrow.report_id, 'status', 'inserted', 'scores', n, 'content_sha256', new_hash);
    exception when others then
      get stacked diagnostics err_constraint = constraint_name;
      c_rr := c_rr + 1;
      refused := refused || jsonb_build_object('report_id', r->>'report_id', 'status', 'refused', 'constraint', nullif(err_constraint, ''), 'reason', sqlerrm);
      results := results || jsonb_build_object('report_id', r->>'report_id', 'status', 'refused', 'constraint', nullif(err_constraint, ''), 'reason', sqlerrm);
    end;
  end loop;

  insert into public.export_runs (dataset, source, adapter_version, started_at, finished_at, projects_inserted, projects_updated, projects_unchanged,
                                  reports_inserted, reports_unchanged, reports_evidence_updated, reports_refused, scores_inserted, refused)
  values (ds, batch->>'source', batch->>'adapter_version', started, clock_timestamp(), c_pi, c_pu, c_pn, c_ri, c_rn, c_re, c_rr, c_si, refused)
  returning export_id into run_id;

  return jsonb_build_object(
    'export_id', run_id,
    'dataset', ds,
    'finished_at', clock_timestamp(),
    'projects', jsonb_build_object('inserted', c_pi, 'updated', c_pu, 'unchanged', c_pn),
    'reports', jsonb_build_object('inserted', c_ri, 'unchanged', c_rn, 'evidence_updated', c_re, 'refused', c_rr),
    'scores_inserted', c_si,
    'results', results);
end;
$$;

comment on function public.explorer_import(jsonb) is 'CryptoResearch Explorer: the only write path. One transaction; each report whole or not at all; conflicting content refused.';

-- ---------------------------------------------------------------------------
-- Row level security and privileges

alter table public.projects enable row level security;
alter table public.reports enable row level security;
alter table public.category_scores enable row level security;
alter table public.export_runs enable row level security;
-- No policies: the anon and authenticated roles see no rows. service_role
-- bypasses RLS, so the desk's backend checks its own sign-in on every request.

revoke all on table public.projects, public.reports, public.category_scores, public.export_runs from public, anon, authenticated, service_role;
grant select on table public.projects, public.reports, public.category_scores, public.export_runs to service_role;
grant insert on table public.projects, public.reports, public.category_scores, public.export_runs to service_role;
grant update (name, ticker, identity_status, chain, contract_address, native_chain, updated_at) on table public.projects to service_role;
grant update (evidence_summary, evidence_coverage, evidence_high, evidence_medium, evidence_low, evidence_checked_at) on table public.reports to service_role;
grant update (evidence_flags) on table public.category_scores to service_role;

revoke all on function public.explorer_import(jsonb) from public, anon, authenticated;
grant execute on function public.explorer_import(jsonb) to service_role;
revoke all on function public.explorer_refuse_change() from public, anon, authenticated, service_role;
