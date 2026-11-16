-- ============================================================================
-- 0348_dispatch_courier.sql — Programar en lote con courier en Repro Lima
-- (MOM §6.2 y §9.5; owner, 16-11-2026: «con un botón ya lo dejamos programados
-- exactamente para un courier… en el caso de GF Courier ya se crea incluso
-- hasta la guía para la fecha que se programe»).
--
-- 1. `order_master.dispatch_courier`: el courier elegido en «Programar envío»
--    (`dispatch_date_set.payload.courier`), al lado de `dispatch_scheduled_on`
--    y con la misma regla: solo mientras el pedido sigue en Preparación · Por
--    generar rótulo sin guía. La guía GF automática no toma un pedido
--    programado con otro courier, y la fila de Repro Lima dice con quién sale.
--    Los valores los decide `isDispatchCourier` (propio, gf_courier, aliclik,
--    fenix); es una tabla derivada, así que no lleva CHECK: un valor raro no
--    debe frenar el recálculo del Master.
-- 2. `lima_repro_calls_sin_contacto`: el canal `sin_contacto` también vale con
--    `confirma`. Es el acuerdo que nace al programar en lote un no entregado
--    «Por acordar» sin hablar con la clienta. La RPC ya no lo cuenta como
--    llamada (`v_contact = 0`).
--
-- Aditiva: sin drop de datos, no toca filas y se puede correr otra vez. Sin
-- ella, «Programar envío» con courier falla al recalcular el Master y el
-- acuerdo sin llamada falla con el error del CHECK; lo demás sigue igual.
-- Se aplica a mano ANTES del código (DEPLOY.md).
-- ============================================================================

alter table public.order_master
  add column if not exists dispatch_courier text;

comment on column public.order_master.dispatch_courier is
  'Courier elegido en «Programar envío» (dispatch_date_set.payload.courier): propio, gf_courier, aliclik o fenix. Solo en Preparación · Por generar rótulo.';

alter table public.lima_repro_calls
  drop constraint if exists lima_repro_calls_sin_contacto;

alter table public.lima_repro_calls
  add constraint lima_repro_calls_sin_contacto
  check (channel <> 'sin_contacto' or outcome in ('no_quiere', 'confirma'));
