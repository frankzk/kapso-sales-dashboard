-- ============================================================================
-- 0046_geo_peru.sql — tabla de referencia distrito → provincia → departamento.
--
-- Por qué hace falta: el Master exige un filtro MULTI-SELECT por provincia
-- (§13), pero Shopify Perú solo entrega dos niveles de dirección:
--   shippingAddress.city     = distrito
--   shippingAddress.province = departamento / región
-- La provincia (el nivel intermedio del ubigeo) NO llega de Shopify. Hoy solo
-- aparece cuando la trae el Excel de Aliclik (shipments.province, 0039), así que
-- para Lima y para cualquier pedido sin guía Aliclik quedaría en NULL y el
-- filtro sería inservible.
--
-- Esta tabla resuelve la provincia a partir del distrito normalizado. Se siembra
-- de dos formas, complementarias:
--   1) BACKFILL automático (abajo) desde los pares distrito+provincia que los
--      reportes de Aliclik ya dejaron en `shipments` — cubre de entrada toda la
--      geografía donde la operación ya despachó.
--   2) Carga del ubigeo completo del INEI vía scripts/seed-ubigeo.ts, para
--      cubrir también los distritos a los que todavía no se ha despachado.
--
-- La tabla es de referencia (no lleva store_id): legible por cualquier usuario
-- autenticado, escrita por el service role.
-- ============================================================================

-- Clave de comparación: minúsculas, sin acentos, espacios colapsados. IMMUTABLE
-- para poder usarla en índices y en columnas generadas. Deliberadamente sin la
-- extensión `unaccent` (no está garantizada en el proyecto Supabase): translate()
-- cubre las vocales acentuadas y la ñ, que es todo lo que aparece en el ubigeo.
create or replace function public.geo_key(raw text)
returns text
language sql
immutable
as $$
  select nullif(
    btrim(
      regexp_replace(
        lower(translate(coalesce(raw, ''),
                        'áéíóúüñÁÉÍÓÚÜÑàèìòùÀÈÌÒÙ',
                        'aeiouunAEIOUUNaeiouAEIOU')),
        '\s+', ' ', 'g'
      )
    ),
    ''
  );
$$;

create table if not exists peru_districts (
  district_key text primary key,          -- geo_key(distrito)
  district     text not null,             -- etiqueta legible
  province     text not null,
  department   text,
  source       text not null default 'shipments',  -- shipments | inei | manual
  updated_at   timestamptz not null default now()
);

create index if not exists peru_districts_province_idx   on peru_districts(province);
create index if not exists peru_districts_department_idx on peru_districts(department);

alter table peru_districts enable row level security;

drop policy if exists peru_districts_select on peru_districts;
create policy peru_districts_select on peru_districts for select to authenticated
  using (true);

grant select on peru_districts to authenticated;
grant all privileges on peru_districts to service_role;

-- ── Backfill desde los reportes de Aliclik ya ingestados ─────────────────────
-- Un distrito puede aparecer escrito de varias formas; nos quedamos con el par
-- (provincia, departamento) más frecuente por distrito, y con la etiqueta más
-- vista. Idempotente: on conflict do nothing, para no pisar una fila del INEI
-- (que es más fiable) con una inferida de un Excel.
insert into peru_districts (district_key, district, province, department, source)
select
  public.geo_key(s.district)                as district_key,
  mode() within group (order by s.district) as district,
  mode() within group (order by s.province) as province,
  mode() within group (order by s.region)   as department,
  'shipments'
from shipments s
where public.geo_key(s.district) is not null
  and public.geo_key(s.province) is not null
group by public.geo_key(s.district)
on conflict (district_key) do nothing;
