-- ⚠️  THROWAWAY TEST CLUSTERS ONLY — never run against a real Supabase DB.
-- This stubs the Supabase-managed roles + auth schema so our migrations and
-- RLS policies can be applied and exercised on a vanilla Postgres. It REPLACES
-- auth.uid() with a GUC-driven version, which would break real auth.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;  -- Supabase sets BYPASSRLS on service_role

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
