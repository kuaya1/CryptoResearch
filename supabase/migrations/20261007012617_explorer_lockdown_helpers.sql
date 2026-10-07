-- CryptoResearch Explorer, schema 1 follow-up (2026-10-06).
--
-- New Supabase projects come with public.rls_auto_enable(), the event trigger
-- function that switches RLS on for every new table in public. It is SECURITY
-- DEFINER and, by the default privileges, executable by anon and
-- authenticated through the Data API (the security advisor's warnings 0028
-- and 0029). The event trigger keeps working without those grants (it is
-- fired by the server for the role running the DDL); only the API route to
-- the function is closed.

revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
