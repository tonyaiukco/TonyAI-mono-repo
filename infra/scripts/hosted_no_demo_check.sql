-- Hosted no-demo check (LP2-04, #259 follow-up). Read-only; run as the owner in the
-- Supabase SQL editor or the owner psql (runbook 05's container on macOS). Every row
-- must read 0 / PASS. Identifiers are bound to the seed by infra/tests/test_hosted_no_demo_check.py.
begin transaction read only;
with checks(name, found) as (
  select 'seed_auth_users', (select count(*) from auth.users where lower(email) like '%@tonyai.local')
  union all
  select 'seed_profiles', (select count(*) from public.profiles where lower(email) like '%@tonyai.local')
  union all
  select 'demo_organisation', (select count(*) from public.organisations where id = '11111111-1111-1111-1111-111111111111')
  union all
  select 'internal_factor_releases', (select count(*) from public.factor_releases where publisher in ('TonyAI prototype', 'TonyAI test fixture'))
  union all
  select 'demo_factor_rows', (select count(*) from public.emission_factors where starts_with(source, 'docs/md_docs/calculation_logic.md §3 (prototype demo factors)'))
)
select name, found, case when found = 0 then 'PASS' else 'FAIL' end as verdict from checks
union all
select 'overall', (select sum(found) from checks), case when (select sum(found) from checks) = 0 then 'PASS' else 'FAIL' end;
rollback;
