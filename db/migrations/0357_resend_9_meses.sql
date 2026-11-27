-- ============================================================================
-- 0357_resend_9_meses.sql — Correo · Resend: el tramo «pidieron en 9 meses»
-- (owner, 27-11-2026: «¿puede ser uno de 9 meses? o lo que cubra poco menos de
-- 10 mil para cubrir la cuota»; MOM §46.2).
--
-- El plan de Resend de Kenku es de 10.000 contactos: 9 meses son 9.188 y 10
-- meses ya pasan (10.140). Se agrega el tramo `9m` entre `6m` y `12m`:
-- 1. `resend_imports.bucket` acepta '9m'.
-- 2. `resend_marketing_counts` devuelve también `last_9m` (cambia lo que
--    devuelve, así que se borra y se vuelve a crear; mismos permisos).
--
-- Aditiva: no toca filas. Sin ella, la página cuenta los demás tramos y la
-- subida de 9 meses no queda registrada.
-- ============================================================================

alter table public.resend_imports drop constraint if exists resend_imports_bucket_check;
alter table public.resend_imports add constraint resend_imports_bucket_check
  check (bucket in ('6m', '9m', '12m', 'todos'));

drop function if exists public.resend_marketing_counts(uuid, text[]);
create function public.resend_marketing_counts(p_org uuid, p_exclude_domains text[] default '{}')
returns table(store_id uuid, store_name text, total bigint, last_6m bigint, last_9m bigint, last_12m bigint)
language sql stable security invoker set search_path=public,pg_temp as $$
  select s.id, s.name,
    count(*)::bigint,
    count(*) filter (where c.last_order_at > now() - interval '6 months')::bigint,
    count(*) filter (where c.last_order_at > now() - interval '9 months')::bigint,
    count(*) filter (where c.last_order_at > now() - interval '12 months')::bigint
  from stores s
  cross join lateral public.resend_marketing_contacts(s.id, p_exclude_domains) c
  where s.org_id = p_org
  group by s.id, s.name
  order by s.name
$$;

revoke all on function public.resend_marketing_counts(uuid, text[]) from public, anon, authenticated;
grant execute on function public.resend_marketing_counts(uuid, text[]) to service_role;
