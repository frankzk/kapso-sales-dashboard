-- ⚠️  THROWAWAY TEST CLUSTERS ONLY — never run against a real Supabase DB.
-- This stubs the Supabase-managed roles + auth schema so our migrations and
-- RLS policies can be applied and exercised on a vanilla Postgres. It REPLACES
-- auth.uid() with a GUC-driven version, which would break real auth.
-- Los ROLES son del cluster, no de la base: si el mismo cluster levanta una
-- segunda base para otra comprobación (verify-db.sh lo hace para probar
-- db/apply_bundled.sql desde cero), ya existen. Todo lo demás sí es por base y
-- hay que crearlo cada vez.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;  -- Supabase le pone BYPASSRLS
  end if;
end $$;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.test_uid', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Supabase concede TODOS los privilegios sobre cada tabla nueva del esquema
-- público a los tres roles. Sin esto, una migración que "olvida" revocar pasaba
-- la prueba aquí y llegaba a producción con permisos de más — que es
-- exactamente lo que ocurrió y arregla 0053. Replicarlo hace que la prueba de
-- privilegios sea fiel al entorno real.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
