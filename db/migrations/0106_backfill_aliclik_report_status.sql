-- ============================================================================
-- 0106 — Destrancar las guías Aliclik «pendiente» que el importador viejo
-- congeló, con respaldo para poder revertir.
--
-- POR QUÉ. Hasta ahora `lib/aliclik-import.ts` colapsaba el reporte de Aliclik a
-- un binario entregado-vs-pendiente: cualquier ESTADO ENTREGA distinto de
-- ENTREGADO se guardaba como `pendiente`. Guías que Aliclik ya movió a CANCELADO
-- / ANULADO / RECHAZADO / NO CONTESTA / REPROGRAMADO, o que ya salieron del
-- almacén (RECOLECTADO / EN TRÁNSITO / POR DEVOLVER / EN AGENCIA / DEVUELTO),
-- quedaban clavadas en `pendiente` y el Master las dibujaba en
-- `Preparación · Por armar` para siempre. El parser ya se corrigió; esta
-- migración adelanta esa corrección sobre las filas ya materializadas, que si no
-- seguirían congeladas hasta que Aliclik las volviera a listar en un Excel.
--
-- APLICAR DESPUÉS DEL DEPLOY del parser corregido. Si se aplica antes, un import
-- en la ventana intermedia vuelve a congelar filas con el mapeo viejo y deshace
-- parte del backfill en silencio.
--
-- ----------------------------------------------------------------------------
-- CÓMO ELIGE EL ESTADO (y por qué NO es «el reporte más reciente»)
-- ----------------------------------------------------------------------------
-- Una misma guía tiene VARIOS `import_rows` (373 de 383 acá), y 259 de ellas
-- traen filas CONTRADICTORIAS, a veces con el MISMO `created_at` — el Excel de
-- Aliclik repite la guía por ítem y no siempre coincide consigo mismo:
--
--     AUR5X836431268256   ENTREGADO/VALIDADO      @07-25 15:32
--                         CANCELADO/POR DEVOLVER  @07-25 15:32
--
-- Por eso «tomar el reporte más reciente» (`distinct on … order by created_at
-- desc`) sería a la vez incorrecto y NO REPRODUCIBLE: entre filas empatadas
-- Postgres elige según el plan, y esa elección arbitraria decidiría `anulado` vs
-- `entregado` en cientos de guías vivas.
--
-- El importador real no hace eso: pliega fila por fila con
-- `reconcileDeliveryStatus` (lib/shipments.ts), que solo AVANZA según
-- STATUS_PRECEDENCE — pendiente 1 · en_ruta 2 · anulado 3 · entregado 3 ·
-- transferido 4 — con `>` estricto. Replicamos ese pliegue de forma determinista:
--   máxima precedencia entre todos los reportes de la guía,
--   desempate por el más ANTIGUO (created_at, row_index) — igual que el fold
--   cronológico, donde el primer rango 3 gana y ningún rango menor lo desplaza.
--
-- CONTRADICCIÓN REAL (`entregado` Y `anulado` en la misma guía): NO se toca.
-- `anulado` y `entregado` empatan en 3, así que el desempate sería una moneda al
-- aire entre «cobrada» y «cancelada» — plata. Se dejan en `pendiente` para
-- revisión humana. Hoy es 1 guía; listarlas:
--
--   select s.guide_code, ir.raw->>'ESTADO ENTREGA', ir.raw->>'ESTADO DESPACHO'
--     from shipments s join import_rows ir on ir.shipment_id = s.id
--    where s.courier='aliclik' and s.delivery_status='pendiente'
--    order by s.guide_code;
--
-- ----------------------------------------------------------------------------
-- ALCANCE Y SEGURIDAD
-- ----------------------------------------------------------------------------
-- SOLO AVANZA: el WHERE exige `delivery_status = 'pendiente'` y descarta el mapeo
-- a `pendiente`, así que nunca retrocede un estado ni reabre un terminal, y es
-- idempotente (correrla dos veces no cambia nada la segunda vez). En una base
-- recién creada no afecta ninguna fila. Las guías `transferido` (madre de una
-- hija Fénix) no son candidatas: ya no están en `pendiente`.
--
-- ESTO NO ANULA VENTAS EN SHOPIFY. Un `anulado` acá es de GUÍA. El pedido pasa a
-- `anulado` general solo cuando TODAS sus guías lo están y ninguna sigue activa
-- (`resolveOrderState`), y eso es reversible con un override; nunca toca el
-- pedido en Shopify (MOM §3.4, §9.4).
--
-- `order_master` NO se recalcula acá: su macroetapa la deriva
-- `resolveOrderMacroStage` en TypeScript. `runStoreSync` solo refresca los
-- pedidos que toca desde Shopify, así que estas guías NO se recalculan solas.
-- Después de aplicar hay que correr `pnpm exec tsx scripts/backfill-mom.ts`
-- (idempotente). Hasta entonces el Master sigue mostrándolas en Por armar.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Respaldo: `delivery_status` no tiene historial, así que sin esto el cambio es
-- irreversible. Se llena en el MISMO statement que muta (CTE modificadora), de
-- modo que respaldo y update no pueden divergir.
-- ----------------------------------------------------------------------------
create table if not exists shipments_status_backup_0106 (
  shipment_id           uuid primary key references shipments(id) on delete cascade,
  guide_code            text not null,
  prev_delivery_status  text not null,
  prev_status_category  text not null,
  prev_delivered_source text,
  new_delivery_status   text not null,
  backed_up_at          timestamptz not null default now()
);

-- Sin policies a propósito: es un artefacto de operación, no dato de tienda.
-- RLS activo + cero policies = nadie autenticado lo lee; `service_role` la evita.
alter table shipments_status_backup_0106 enable row level security;
grant all privileges on shipments_status_backup_0106 to service_role;

comment on table shipments_status_backup_0106 is
  'Pre-imagen de las guías Aliclik mutadas por la migración 0106. Permite revertir el backfill. Se puede borrar una vez verificado.';

-- REVERTIR (todo, o filtrando por guide_code):
--   update shipments s
--      set delivery_status  = b.prev_delivery_status,
--          status_category  = b.prev_status_category,
--          delivered_source = b.prev_delivered_source
--     from shipments_status_backup_0106 b
--    where s.id = b.shipment_id;
--   -- y volver a correr scripts/backfill-mom.ts

with cand as (
  select id, store_id, guide_code, delivery_status, status_category, delivered_source
    from shipments
   where courier = 'aliclik'
     and delivery_status = 'pendiente'
     and guide_code is not null
),
-- El enlace explícito (`shipment_id`) es el que escribe el importador al
-- matchear; el match por código cubre las filas que quedaron sin enlazar.
-- Acotado por tienda para que una guía no pueda cruzarse entre stores.
rows_all as (
  select c.id, c.guide_code, c.delivery_status as prev_status,
         c.status_category as prev_category, c.delivered_source as prev_source,
         ir.created_at, ir.row_index,
         case
           when upper(ir.raw->>'ESTADO ENTREGA') = 'ENTREGADO' then 'entregado'
           when upper(ir.raw->>'ESTADO DESPACHO') = 'DEVUELTO' then 'anulado'
           when upper(ir.raw->>'ESTADO ENTREGA') in ('CANCELADO', 'ANULADO') then 'anulado'
           when upper(ir.raw->>'ESTADO ENTREGA') in ('REPROGRAMADO', 'RECHAZADO', 'NO CONTESTA') then 'en_ruta'
           when upper(ir.raw->>'ESTADO DESPACHO') in
             ('RECOLECTADO', 'REMANENTE EN TRÁNSITO', 'ALMACÉN CENTRAL', 'POR DEVOLVER', 'EN AGENCIA') then 'en_ruta'
           else 'pendiente'
         end as canonical
    from cand c
    join import_rows ir
      on ir.shipment_id = c.id
      or (ir.store_id = c.store_id and ir.raw->>'NRO. PEDIDO' = c.guide_code)
),
-- Mismo STATUS_PRECEDENCE que lib/shipments.ts.
ranked as (
  select *, case canonical
              when 'entregado' then 3
              when 'anulado'   then 3
              when 'en_ruta'   then 2
              else 1
            end as prec
    from rows_all
),
conflict as (
  select id from ranked
   group by id
  having bool_or(canonical = 'entregado') and bool_or(canonical = 'anulado')
),
final as (
  select distinct on (id) id, guide_code, prev_status, prev_category, prev_source, canonical
    from ranked
   where id not in (select id from conflict)
   order by id, prec desc, created_at asc, row_index asc  -- determinista
),
upd as (
  update shipments s
     set delivery_status = f.canonical,
         status_category = case f.canonical
           when 'entregado' then 'delivered'
           when 'anulado'   then 'closed'
           when 'en_ruta'   then 'in_route'
           else 'pending'
         end,
         -- Mismo precedente que 0026: el reporte de Aliclik es la fuente.
         delivered_source = case
           when f.canonical = 'entregado' and s.delivered_source is null then 'aliclik'
           else s.delivered_source
         end
    from final f
   where s.id = f.id
     and s.delivery_status = 'pendiente'  -- solo avanza; nunca reabre un terminal
     and f.canonical <> 'pendiente'
  returning f.id, f.guide_code, f.prev_status, f.prev_category, f.prev_source, f.canonical
)
insert into shipments_status_backup_0106
  (shipment_id, guide_code, prev_delivery_status, prev_status_category,
   prev_delivered_source, new_delivery_status)
select id, guide_code, prev_status, prev_category, prev_source, canonical
  from upd
-- Si se re-corriera tras un revert parcial, conserva la pre-imagen ORIGINAL.
on conflict (shipment_id) do nothing;
