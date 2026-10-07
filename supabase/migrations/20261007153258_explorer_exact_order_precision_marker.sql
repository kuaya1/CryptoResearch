-- CryptoResearch Explorer, schema 2 (2026-10-07): the desk's exact order,
-- exact category values, and a consistency marker. Review of 2026-10-07,
-- findings 3, 4 and 7.
--
-- Additive only. No column is dropped or retyped, no stored value changes,
-- every stored report keeps its content_sha256, and the two earlier
-- migrations are not edited (their functions are replaced here, as
-- CREATE OR REPLACE, with the schema-1 behavior kept).
--
-- 1. Exact order (finding 3). reports.research_date keeps the analysis day
--    only, so two reports by one model on one day were ordered by save time
--    while the desk orders them by the stated instant. Two columns hold what
--    the desk orders by (dashboard/core/reports.js reportOrder):
--      order_basis  analysis_time          a stated time with its zone
--                   analysis_time_no_zone  a stated time without a zone, read as UTC
--                   analysis_date          a stated date, at its UTC midnight
--                   save_time              a stated time the desk does not use
--                                          (after the save, unreadable, not ISO)
--                   undated                nothing stated (sorts first)
--      order_at     that instant (null when undated)
--    Reports stored before this migration have neither: their order is known
--    to the day only, and the desk's reader says so. No time is invented for
--    them; an export with complete_existing adds the desk's own values once.
--
-- 2. Exact category values (finding 7). score, score_low and score_high are
--    numeric(5,2): a source value such as 68.025 is stored as 68.03, without
--    a word. Those columns stay (they are the two-decimal reading, and the
--    content hash is computed from them as before); three unconstrained
--    numeric columns keep the exact value the export sent, and each must
--    round to its two-decimal column:
--      score_exact, score_low_exact, score_high_exact
--    Rows stored before this migration have none: their source value is not
--    known here (it may have been rounded), and the reader says so.
--
-- 3. A consistency marker (finding 4). One read is several requests; an
--    export committing between them could pair an older report set with a
--    newer export receipt. public.explorer_state holds one generation number,
--    raised by a statement trigger on every write to the four tables
--    (inserts, evidence refreshes, the completions below, any other write),
--    in the same transaction as the write. The desk reads it before and after
--    assembling an answer; if it moved, the read is repeated (a few times) or
--    said to be "updating", never shown as synced.
--
-- The new report and score columns are set once and never changed (the
-- immutability trigger allows only empty -> value). A later export whose
-- values differ from stored ones is a conflict, like changed content.
--
-- Completing reports stored before this migration: explorer_import(batch)
-- with "complete_existing": true fills the new columns of a stored report
-- from the desk's export only when its content hash matches (it is the same
-- report) and the values pass the constraints (each exact value rounds to the
-- stored two-decimal value; the order instant agrees with the stored day and
-- save time). Without it, such a report is left as it is and counted as
-- metadata_missing. Precision that was already rounded away is not recovered
-- from the database; only the desk's own records can supply it.

-- ---------------------------------------------------------------------------
-- 1. Exact order

alter table public.reports
  add column order_basis text
    constraint reports_order_basis check (order_basis in ('analysis_time', 'analysis_time_no_zone', 'analysis_date', 'save_time', 'undated')),
  add column order_at timestamptz;

alter table public.reports
  add constraint reports_order_shape check (
    (order_basis is null and order_at is null)
    or (order_basis = 'undated' and order_at is null and research_date is null)
    or (order_basis = 'save_time' and order_at = saved_at)
    or (order_basis = 'analysis_date' and order_at = research_date::timestamp at time zone 'UTC')
    or (order_basis in ('analysis_time', 'analysis_time_no_zone') and order_at is not null and research_date = (order_at at time zone 'UTC')::date)),
  add constraint reports_order_not_after_save check (order_at is null or order_at <= saved_at + interval '1 day');

comment on column public.reports.order_basis is 'What the desk orders this report by (reports.js reportOrder). Null: exported before 2026-10-07, ordered by the day only.';
comment on column public.reports.order_at is 'The instant the desk orders this report by; null when undated or not stored.';

-- ---------------------------------------------------------------------------
-- 2. Exact category values

alter table public.category_scores
  add column score_exact numeric,
  add column score_low_exact numeric,
  add column score_high_exact numeric;

alter table public.category_scores
  add constraint category_scores_exact_shape check (
    (score_exact is null or (status = 'scored' and score_exact between 0 and 100 and round(score_exact, 2) = score))
    and (score_low_exact is null or (status = 'range' and score_low_exact between 0 and 100 and round(score_low_exact, 2) = score_low))
    and (score_high_exact is null or (status = 'range' and score_high_exact between 0 and 100 and round(score_high_exact, 2) = score_high))
    and ((score_low_exact is null) = (score_high_exact is null))
    and (score_low_exact is null or score_low_exact <= score_high_exact));

comment on column public.category_scores.score_exact is 'The point exactly as exported; score is its two-decimal reading. Null: stored before 2026-10-07 (source value not known here).';

alter table public.export_runs
  add column reports_metadata_completed integer not null default 0,
  add column reports_metadata_missing integer not null default 0;

grant update (order_basis, order_at) on table public.reports to service_role;
grant update (score_exact, score_low_exact, score_high_exact) on table public.category_scores to service_role;

-- ---------------------------------------------------------------------------
-- 3. The consistency marker

create table public.explorer_state (
  singleton   boolean primary key default true constraint explorer_state_one_row check (singleton),
  generation  bigint not null default 0 constraint explorer_state_generation check (generation >= 0),
  changed_at  timestamptz not null default now()
);

comment on table public.explorer_state is 'CryptoResearch Explorer: one row; generation rises with every write to the Explorer tables (statement triggers), so a reader can tell whether its several requests saw one state.';

insert into public.explorer_state (singleton, generation) values (true, 1);

alter table public.explorer_state enable row level security;
revoke all on table public.explorer_state from public, anon, authenticated, service_role;
grant select on table public.explorer_state to service_role;

create function public.explorer_bump_generation() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.explorer_state set generation = generation + 1, changed_at = clock_timestamp() where singleton;
  return null;
end;
$$;

revoke all on function public.explorer_bump_generation() from public, anon, authenticated, service_role;

create trigger projects_generation after insert or update or delete or truncate on public.projects
  for each statement execute function public.explorer_bump_generation();
create trigger reports_generation after insert or update or delete or truncate on public.reports
  for each statement execute function public.explorer_bump_generation();
create trigger category_scores_generation after insert or update or delete or truncate on public.category_scores
  for each statement execute function public.explorer_bump_generation();
create trigger export_runs_generation after insert or update or delete or truncate on public.export_runs
  for each statement execute function public.explorer_bump_generation();

-- ---------------------------------------------------------------------------
-- Immutability, with the new columns set once

create or replace function public.explorer_refuse_change() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  readings text[] := array['evidence_summary', 'evidence_coverage', 'evidence_high', 'evidence_medium', 'evidence_low', 'evidence_checked_at', 'evidence_flags'];
  -- Schema 2: set once, from empty; never changed afterwards.
  once text[] := case tg_table_name
    when 'reports' then array['order_basis', 'order_at']
    when 'category_scores' then array['score_exact', 'score_low_exact', 'score_high_exact']
    else array[]::text[] end;
  o jsonb;
  n jsonb;
  k text;
begin
  if tg_op = 'UPDATE' and tg_table_name in ('reports', 'category_scores') then
    o := to_jsonb(old);
    n := to_jsonb(new);
    if (n - readings - once) = (o - readings - once) then
      foreach k in array once loop
        if (o -> k) <> 'null'::jsonb and (n -> k) is distinct from (o -> k) then
          raise exception 'CryptoResearch Explorer: % on % refused. % is set once and never changed.', tg_op, tg_table_name, k
            using errcode = 'restrict_violation';
        end if;
      end loop;
      return new;
    end if;
  end if;
  raise exception 'CryptoResearch Explorer: % on % refused. Stored reports, scores and exports never change; a changed report is exported as a new report that names the one it revises.', tg_op, tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

-- ---------------------------------------------------------------------------
-- The one write path, with schema 2
--
-- As schema 1 (one transaction; projects first; each report whole or not at
-- all; the content hash computed here from the schema-1 columns, so stored
-- hashes and "unchanged" mean what they meant), and:
--   - order_basis and order_at are taken from the batch and checked by the
--     constraints;
--   - each category's exact value is the number the batch sent (its "score",
--     "score_low" or "score_high"), kept beside the two-decimal column;
--   - a stored report: a sent order or exact value that differs from a stored
--     one is a conflict (nothing written); a missing one is filled only with
--     batch.complete_existing = true (result metadata "completed"), else the
--     report is left as it is (metadata "missing");
--   - every result says metadata complete, completed or missing.

create or replace function public.explorer_import(batch jsonb) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  ds text := batch->>'dataset';
  complete boolean;
  started timestamptz := clock_timestamp();
  readings text[] := array['evidence_summary', 'evidence_coverage', 'evidence_high', 'evidence_medium', 'evidence_low', 'evidence_checked_at'];
  schema2 text[] := array['order_basis', 'order_at'];
  exact_cols text[] := array['score_exact', 'score_low_exact', 'score_high_exact'];
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
  meta text;
  differs text;
  bad_exact text;
  missing_order boolean;
  missing_exact int;
  results jsonb := '[]';
  refused jsonb := '[]';
  c_pi int := 0; c_pu int := 0; c_pn int := 0;
  c_ri int := 0; c_rn int := 0; c_re int := 0; c_rr int := 0; c_si int := 0;
  c_mc int := 0; c_mm int := 0;
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
  if batch ? 'complete_existing' and jsonb_typeof(batch->'complete_existing') <> 'boolean' then
    raise exception 'batch.complete_existing must be true or false' using errcode = 'check_violation';
  end if;
  complete := coalesce((batch->>'complete_existing')::boolean, false);

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
      -- The content hash, exactly as in schema 1: every schema-1 column except
      -- the bookkeeping and the evidence readings, with its category scores in
      -- category order (two-decimal values). The schema-2 columns are checked
      -- on their own below.
      canon := (to_jsonb(rrow) - readings - schema2 - 'content_sha256' - 'exported_at' - 'dataset')
        || jsonb_build_object('category_scores', coalesce((
             select jsonb_agg(to_jsonb(cs) - 'report_id' - 'evidence_flags' - exact_cols order by cs.category_id)
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
        -- Schema-2 values that differ from stored ones: a conflict, nothing written.
        differs := null;
        if rrow.order_basis is not null and stored.order_basis is not null
           and (rrow.order_basis, rrow.order_at) is distinct from (stored.order_basis, stored.order_at) then
          differs := 'its order (' || stored.order_basis || ' ' || coalesce(stored.order_at::text, 'none') || ' stored, ' || rrow.order_basis || ' ' || coalesce(rrow.order_at::text, 'none') || ' sent)';
        end if;
        select string_agg(s.category_id, ', ' order by s.category_id) into bad_exact
          from public.category_scores s
          join jsonb_array_elements(coalesce(r->'category_scores', '[]')) x on x.value->>'category_id' = s.category_id
         where s.report_id = rrow.report_id
           and ((s.score_exact is not null and s.score_exact is distinct from (case when s.status = 'scored' then (x.value->>'score')::numeric end))
             or (s.score_low_exact is not null and (s.score_low_exact, s.score_high_exact) is distinct from
                   (case when s.status = 'range' then (x.value->>'score_low')::numeric end, case when s.status = 'range' then (x.value->>'score_high')::numeric end)));
        if bad_exact is not null then
          differs := coalesce(differs || ' and ', '') || 'the exact value of ' || bad_exact;
        end if;
        if differs is not null then
          c_rr := c_rr + 1;
          refused := refused || jsonb_build_object('report_id', rrow.report_id, 'status', 'conflict', 'content_sha256', new_hash,
            'reason', 'This report is stored with different ' || differs || '. Stored order and exact values never change.');
          results := results || jsonb_build_object('report_id', rrow.report_id, 'status', 'conflict', 'content_sha256', new_hash, 'differs', differs);
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
        -- Schema-2 values the stored report lacks: filled once, on request.
        missing_order := stored.order_basis is null;
        select count(*) into missing_exact from public.category_scores s
         where s.report_id = rrow.report_id and ((s.status = 'scored' and s.score_exact is null) or (s.status = 'range' and s.score_low_exact is null));
        if not missing_order and missing_exact = 0 then
          meta := 'complete';
        elsif complete and (rrow.order_basis is not null or not missing_order) then
          if missing_order then
            update public.reports set order_basis = rrow.order_basis, order_at = rrow.order_at where report_id = rrow.report_id;
          end if;
          if missing_exact > 0 then
            update public.category_scores s
               set score_exact = case when s.status = 'scored' then (x.value->>'score')::numeric end,
                   score_low_exact = case when s.status = 'range' then (x.value->>'score_low')::numeric end,
                   score_high_exact = case when s.status = 'range' then (x.value->>'score_high')::numeric end
              from jsonb_array_elements(coalesce(r->'category_scores', '[]')) x
             where s.report_id = rrow.report_id and x.value->>'category_id' = s.category_id
               and ((s.status = 'scored' and s.score_exact is null) or (s.status = 'range' and s.score_low_exact is null));
          end if;
          meta := 'completed';
          c_mc := c_mc + 1;
        else
          meta := 'missing';
          c_mm := c_mm + 1;
        end if;
        results := results || jsonb_build_object('report_id', rrow.report_id, 'status', outcome, 'metadata', meta, 'content_sha256', new_hash);
        continue;
      end if;

      rrow.content_sha256 := new_hash;
      rrow.exported_at := now();
      insert into public.reports select (rrow).*;
      insert into public.category_scores (report_id, category_id, category_label, position, status, score, score_low, score_high,
                                          score_exact, score_low_exact, score_high_exact,
                                          confidence, evidence_refs, rationale, main_weakness, unknown_reason, evidence_flags)
      select rrow.report_id, cs.category_id, cs.category_label, cs.position, cs.status, cs.score, cs.score_low, cs.score_high,
             case when cs.status = 'scored' then (x.value->>'score')::numeric end,
             case when cs.status = 'range' then (x.value->>'score_low')::numeric end,
             case when cs.status = 'range' then (x.value->>'score_high')::numeric end,
             cs.confidence, coalesce(cs.evidence_refs, '{}'), cs.rationale, cs.main_weakness, cs.unknown_reason, coalesce(cs.evidence_flags, '[]'::jsonb)
        from jsonb_array_elements(coalesce(r->'category_scores', '[]')) x
        cross join lateral jsonb_populate_record(null::public.category_scores, x.value) cs;
      get diagnostics n = row_count;
      c_ri := c_ri + 1;
      c_si := c_si + n;
      meta := case when rrow.order_basis is not null then 'complete' else 'missing' end;
      if meta = 'missing' then c_mm := c_mm + 1; end if;
      results := results || jsonb_build_object('report_id', rrow.report_id, 'status', 'inserted', 'scores', n, 'metadata', meta, 'content_sha256', new_hash);
    exception when others then
      get stacked diagnostics err_constraint = constraint_name;
      c_rr := c_rr + 1;
      refused := refused || jsonb_build_object('report_id', r->>'report_id', 'status', 'refused', 'constraint', nullif(err_constraint, ''), 'reason', sqlerrm);
      results := results || jsonb_build_object('report_id', r->>'report_id', 'status', 'refused', 'constraint', nullif(err_constraint, ''), 'reason', sqlerrm);
    end;
  end loop;

  insert into public.export_runs (dataset, source, adapter_version, started_at, finished_at, projects_inserted, projects_updated, projects_unchanged,
                                  reports_inserted, reports_unchanged, reports_evidence_updated, reports_refused, scores_inserted,
                                  reports_metadata_completed, reports_metadata_missing, refused)
  values (ds, batch->>'source', batch->>'adapter_version', started, clock_timestamp(), c_pi, c_pu, c_pn, c_ri, c_rn, c_re, c_rr, c_si, c_mc, c_mm, refused)
  returning export_id into run_id;

  return jsonb_build_object(
    'export_id', run_id,
    'dataset', ds,
    'finished_at', clock_timestamp(),
    'complete_existing', complete,
    'projects', jsonb_build_object('inserted', c_pi, 'updated', c_pu, 'unchanged', c_pn),
    'reports', jsonb_build_object('inserted', c_ri, 'unchanged', c_rn, 'evidence_updated', c_re, 'refused', c_rr),
    'metadata', jsonb_build_object('completed', c_mc, 'missing', c_mm),
    'scores_inserted', c_si,
    'generation', (select generation from public.explorer_state where singleton),
    'results', results);
end;
$$;

comment on function public.explorer_import(jsonb) is 'CryptoResearch Explorer: the only write path. One transaction; each report whole or not at all; conflicting content refused; schema-2 order and exact values set once (complete_existing fills stored reports that lack them).';

notify pgrst, 'reload schema';
