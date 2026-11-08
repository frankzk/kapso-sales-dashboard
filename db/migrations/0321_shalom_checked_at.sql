-- ============================================================================
-- 0321_shalom_checked_at.sql — la fila del rastreo de Shalom va por cuándo
-- PREGUNTAMOS, y la guía que Shalom ya no reconoce se ve (MOM §12, 08-11-2026).
--
-- EL CASO. Cada pasada de media hora del rastreo (`/api/cron/shalom-reconcile`)
-- pregunta por unas 250 de ~367 guías vivas, en el orden de `last_report_at`:
-- cuándo CONTESTÓ Shalom. Una guía que Shalom rechaza con `not_found` («No se
-- encontró la orden de servicio») nunca contesta, así que nunca se movía. La
-- bitácora de cada pasada decía lo mismo: 250 preguntadas, 179 contestadas, 71
-- `not_found`, `cortadoPor: tiempo`. Las mismas 71 encabezaban la fila y se
-- comían un tercio del cupo. Entre ellas, guías de agosto a octubre y 38 guías
-- recreadas el 03-11-2026 tras el corte de luz de Shalom Breña cuyas cajas
-- nunca se dejaron en la agencia: Shalom las venció.
--
-- QUÉ AGREGA (aditiva: no reescribe ningún dato que se lea en otro sitio).
--   * `shipments.shalom_checked_at`: cuándo preguntó el rastreo por la guía,
--     contestara Shalom o no. La fila va por esta columna, la nunca preguntada
--     primero. `last_report_at` no cambia de sentido: sigue siendo cuándo
--     contestó, que es lo que leen Cotejar Shalom («el rastreo nunca contestó»)
--     y la ficha.
--   * `shipments.shalom_not_found_since` / `shalom_not_found_count`: la racha
--     de `not_found` seguidos y desde cuándo. Una respuesta de verdad la borra.
--     Con 6 consultas o más y 24 h o más desde la primera, la guía es «Guía
--     Shalom no reconocida» (lib/shalom/check-queue.ts). Nada se anula solo.
--   * Los tres son sellos del rastreo, no cambios de la guía: el trigger de
--     `updated_at` (0204) los ignora, como `api_report_at`. Sin eso, las guías
--     que no contestan dejarían el pedido «desfasado» en cada pasada y el Master
--     las recalcularía para nada (~71 cada media hora).
--   * Un índice para la fila y el sello inicial: `shalom_checked_at` arranca en
--     `last_report_at` en las guías vivas, para que la primera pasada siga el
--     orden de hoy.
--
-- Se puede desplegar el código ANTES de aplicarla: sin estas columnas el
-- rastreo vuelve a ordenar por `last_report_at` y Almacén y la Mesa de
-- despacho no marcan ninguna guía. Correrla otra vez no cambia nada.
-- ============================================================================

alter table public.shipments
  add column if not exists shalom_checked_at timestamptz,
  add column if not exists shalom_not_found_since timestamptz,
  add column if not exists shalom_not_found_count integer not null default 0;

alter table public.shipments drop constraint if exists shipments_shalom_not_found_count_check;
alter table public.shipments add constraint shipments_shalom_not_found_count_check
  check (shalom_not_found_count >= 0);

comment on column public.shipments.shalom_checked_at is
  'Última vez que el rastreo de Shalom preguntó por esta guía, contestara o no (0321). Ordena la fila del rastreo. No es last_report_at: ese es cuándo contestó.';
comment on column public.shipments.shalom_not_found_since is
  'Primer not_found de la racha actual del rastreo de Shalom (0321). Null cuando Shalom contesta.';
comment on column public.shipments.shalom_not_found_count is
  'Consultas not_found seguidas del rastreo de Shalom (0321). Vuelve a 0 cuando Shalom contesta. Con 6 o más y 24 h desde la primera: «Guía Shalom no reconocida».';

-- ── Los sellos del rastreo no mueven `updated_at` ─────────────────────────────
--
-- Misma regla que la 0204 para `api_report_at` y `api_updated_at`: una
-- actualización que solo toca sellos de lectura deja `updated_at` como estaba.
-- `last_report_at` sigue fuera de la lista, por lo que explica la 0204.
create or replace function public.shipments_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  if (to_jsonb(new) - array['updated_at', 'api_report_at', 'api_updated_at',
                            'shalom_checked_at', 'shalom_not_found_since', 'shalom_not_found_count'])
     is not distinct from
     (to_jsonb(old) - array['updated_at', 'api_report_at', 'api_updated_at',
                            'shalom_checked_at', 'shalom_not_found_since', 'shalom_not_found_count']) then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end
$$;

-- La fila: nunca preguntada primero, después la que hace más que no se pregunta.
create index if not exists shipments_shalom_check_queue_idx
  on public.shipments (shalom_checked_at nulls first, created_at)
  where courier = 'shalom' and guide_code is not null;

-- El sello inicial: la primera pasada sigue el orden de hoy. Solo las vivas y
-- solo las que todavía no tienen sello (idempotente). Con el trigger de arriba
-- ya puesto, no mueve `updated_at`.
update public.shipments
   set shalom_checked_at = last_report_at
 where courier = 'shalom'
   and shalom_checked_at is null
   and last_report_at is not null
   and delivery_status not in ('entregado', 'anulado', 'transferido');
