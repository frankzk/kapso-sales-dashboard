-- ============================================================================
-- 0317_history_guide_auto.sql — Confirmación por Chatby: «Guía automática
-- para clientas con entregas» (MOM §6.1 y §40; owner, 08-11-2026).
--
-- POR QUÉ. La clienta confirmó por Chatby y la guía Aliclik no sale sola por
-- la dirección: está incompleta (`direccion_incompleta`) o Google no la ubica
-- y no mandó su ubicación (`sin_ubicacion`). Si esa clienta (mismo celular,
-- misma organización) ya recibió en esa misma dirección, sin un solo fallido
-- (ni «No entregado», ni rechazo en la puerta, ni devuelto), el owner quiere
-- que la guía salga igual con el GPS de la guía de esa entrega, por el mismo
-- camino que la ubicación de WhatsApp y con todas las rejas de siempre. Va
-- antes de que Kapta le pida la dirección o la ubicación (0318). Caso que lo
-- motivó: #KP204102. La regla está en lib/history-guide-auto.ts.
--
-- QUÉ AGREGA (aditiva: no reescribe ninguna fila).
--   * `chatby_auto_settings.history_guide_mode`: Apagado / Simulación /
--     Activo, por organización. Nace `apagado`: lo de hoy. En `simulacion` la
--     pasada dice «habría creado la guía con el GPS de #…» y el pedido sigue
--     como hoy; en `activo` crea la guía y confirma.
--
-- Lo demás no necesita columnas: lo que decidió la regla va en
-- `chatby_auto_checks.evidence.history_guide` (como `auto_asks` de la 0318),
-- y la guía deja el hecho `chatby_history_guide` en `order_events` con el
-- pedido del que salió el GPS. Sin esta migración la pasada lo trata como
-- Apagado. Correrla otra vez no cambia nada. Se aplica a mano (DEPLOY.md).
-- ============================================================================

alter table public.chatby_auto_settings
  add column if not exists history_guide_mode text not null default 'apagado';
alter table public.chatby_auto_settings drop constraint if exists chatby_auto_settings_history_guide_mode_check;
alter table public.chatby_auto_settings add constraint chatby_auto_settings_history_guide_mode_check
  check (history_guide_mode in ('apagado', 'simulacion', 'activo'));
comment on column public.chatby_auto_settings.history_guide_mode is
  'Guía Aliclik con el GPS de una entrega anterior de la clienta cuando la guía de Chatby no sale por la dirección (0317): apagado | simulacion | activo.';
