-- 0070 — De dónde salió cada tarifa logística.
--
-- POR QUÉ. El cron de tarifas de Aliclik cotiza cada distrito y escribe lo que
-- ALIDRIVER cobra allí. Sin marcar la procedencia, esas filas y las que pone una
-- persona a mano son indistinguibles, y `resolveTariff` desempata por
-- `effective_from`: la más reciente gana. Como el cron corre a diario, SIEMPRE
-- ganaría — y pisaría en silencio cualquier acuerdo que el equipo hubiera
-- registrado. Una tarifa negociada tiene que sobrevivir al robot.
--
-- Con esta columna el cron solo mira y toca lo suyo (`source='aliclik'`), y
-- deja intacto lo de `source='manual'`. Es el mismo criterio que ya usa
-- `aliclik_sku_map.source` para no pisar los mapeos hechos a mano.

alter table cost_tariffs
  add column if not exists source text not null default 'manual';

comment on column cost_tariffs.source is
  'manual = la puso una persona y nada automático la toca. aliclik = la escribió el '
  'cron cotizando GET /integration/order/shipping/cost para ese distrito.';

-- El cron busca sus propias filas vigentes por ámbito en cada pasada.
create index if not exists cost_tariffs_source_idx
  on cost_tariffs (org_id, source, concept, district)
  where effective_to is null;

-- ----------------------------------------------------------------------------
-- Qué distritos cotizar en la próxima pasada
-- ----------------------------------------------------------------------------

-- Un punto representativo por distrito, tomado de un pedido REAL que espera.
--
-- Va en SQL y no en la aplicación porque el conjunto de partida son ~6.600
-- pedidos: agrupar eso en el servidor significa traérselos todos por la red para
-- quedarse con 60 filas. Aquí se resuelve con un índice y devuelve solo lo justo.
--
-- El orden decide qué se cotiza primero y por qué:
--   1. lo que NUNCA se ha cotizado, para ir cubriendo el mapa;
--   2. dentro de eso, los distritos con más pedidos esperando, que son los que
--      más mueven el margen;
--   3. lo ya cotizado va al final y por antigüedad, para que los precios viejos
--      se refresquen sin bloquear a los que aún no tienen tarifa.
create or replace function aliclik_tariff_probes(p_store_id uuid, p_limit int)
returns table (district text, lat double precision, lng double precision, pending bigint)
language sql
stable
security definer
set search_path = public
as $$
  with pend as (
    select om.district,
           om.latitude,
           om.longitude,
           row_number() over (partition by om.district order by om.order_created_at desc) as rn,
           count(*) over (partition by om.district) as pending
    from order_master om
    where om.store_id = p_store_id
      and om.guide_code is null
      and om.general_status in ('pendiente', 'en_proceso')
      and om.district is not null
      and om.latitude is not null
      and om.longitude is not null
  ),
  quoted as (
    select lower(btrim(t.district)) as district, max(t.effective_from) as last_quoted
    from cost_tariffs t
    where t.source = 'aliclik' and t.district is not null
    group by 1
  )
  select p.district, p.latitude, p.longitude, p.pending
  from pend p
  left join quoted q on q.district = lower(btrim(p.district))
  where p.rn = 1
  order by (q.last_quoted is not null), q.last_quoted asc nulls first, p.pending desc
  limit p_limit;
$$;

revoke all on function aliclik_tariff_probes(uuid, int) from public, anon, authenticated;
