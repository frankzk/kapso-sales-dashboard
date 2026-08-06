-- 0106 — Destrancar las guías Aliclik «pendiente» que el importador viejo
-- congeló.
--
-- POR QUÉ. Hasta ahora `lib/aliclik-import.ts` colapsaba el reporte de Aliclik a
-- un binario entregado-vs-pendiente: cualquier ESTADO ENTREGA distinto de
-- ENTREGADO se guardaba como `pendiente`. Así, guías que Aliclik ya movió a
-- CANCELADO / ANULADO / RECHAZADO / NO CONTESTA / REPROGRAMADO, o que ya salieron
-- del almacén (RECOLECTADO / EN TRÁNSITO / POR DEVOLVER / EN AGENCIA / DEVUELTO),
-- quedaban clavadas en `pendiente` y el Master las dibujaba en
-- `Preparación · Por armar` para siempre. El parser ya se corrigió para derivar
-- el estado del trío ESTADO ENTREGA + DESPACHO (misma tabla de equivalencias que
-- `mapAliclikStatus`); esta migración adelanta esa corrección sobre las filas ya
-- materializadas, que si no seguirían congeladas hasta que Aliclik las volviera a
-- listar en un Excel.
--
-- QUÉ HACE. Para cada guía Aliclik todavía en `pendiente`, toma su reporte más
-- reciente y recalcula el `delivery_status` con la MISMA precedencia que el
-- parser y `mapAliclikStatus`:
--   * ENTREGADO                                   → entregado (cierra).
--   * DEVUELTO (despacho)                          → anulado (volvió al origen).
--   * CANCELADO / ANULADO                          → anulado.
--   * RECHAZADO / NO CONTESTA / REPROGRAMADO       → en_ruta (sigue en calle).
--   * RECOLECTADO / REMANENTE EN TRÁNSITO /
--     ALMACÉN CENTRAL / POR DEVOLVER / EN AGENCIA  → en_ruta (ya salió).
--   * el resto (POR PREPARAR / VALIDADO /
--     DEJADO EN ALMACÉN / POR ENTREGAR)            → pendiente (sigue en almacén).
--
-- SOLO AVANZA. El WHERE exige `delivery_status = 'pendiente'` y descarta el mapeo
-- a `pendiente`, así que nunca retrocede un estado ni reabre un terminal, y es
-- idempotente: correrla dos veces no cambia nada la segunda vez. En una base
-- recién creada (sin envíos ni reportes) no afecta ninguna fila.
--
-- OJO — ESTO NO ANULA VENTAS EN SHOPIFY. Un `anulado` acá es de GUÍA. El pedido
-- solo pasa a `anulado` general cuando TODAS sus guías están anuladas y ninguna
-- activa (`resolveOrderState`), y eso es reversible con un override; nunca toca
-- el pedido en Shopify (MOM §3.4, §9.4).
--
-- `order_master` NO se recalcula acá: su macroetapa la deriva `resolveOrderMacroStage`
-- en TypeScript desde estas guías. Tras esta migración hay que correr
-- `scripts/backfill-mom.ts` (idempotente) para que el Master refleje los nuevos
-- estados; el código desplegado ya mapea en_ruta → En curso y anulado → Finalizado.

with cand as (
  select id, guide_code
    from shipments
   where courier = 'aliclik'
     and delivery_status = 'pendiente'
     and guide_code is not null
),
-- El reporte más reciente por guía (identidad por su código AUR5X, igual que el parser).
rep as (
  select distinct on (c.id) c.id, ir.raw
    from cand c
    join import_rows ir on ir.raw->>'NRO. PEDIDO' = c.guide_code
   order by c.id, ir.created_at desc
),
mapped as (
  select id,
    case
      when upper(raw->>'ESTADO ENTREGA') = 'ENTREGADO' then 'entregado'
      when upper(raw->>'ESTADO DESPACHO') = 'DEVUELTO' then 'anulado'
      when upper(raw->>'ESTADO ENTREGA') in ('CANCELADO', 'ANULADO') then 'anulado'
      when upper(raw->>'ESTADO ENTREGA') in ('REPROGRAMADO', 'RECHAZADO', 'NO CONTESTA') then 'en_ruta'
      when upper(raw->>'ESTADO DESPACHO') in
        ('RECOLECTADO', 'REMANENTE EN TRÁNSITO', 'ALMACÉN CENTRAL', 'POR DEVOLVER', 'EN AGENCIA') then 'en_ruta'
      else 'pendiente'
    end as canonical
    from rep
)
update shipments s
   set delivery_status = m.canonical,
       status_category = case m.canonical
         when 'entregado' then 'delivered'
         when 'anulado' then 'closed'
         when 'en_ruta' then 'in_route'
         else 'pending'
       end,
       delivered_source = case
         when m.canonical = 'entregado' and s.delivered_source is null then 'aliclik'
         else s.delivered_source
       end
  from mapped m
 where s.id = m.id
   and s.delivery_status = 'pendiente'  -- solo avanza; nunca reabre un terminal
   and m.canonical <> 'pendiente';
