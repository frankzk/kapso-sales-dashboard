-- ============================================================================
-- 0316_chatby_approx_location.sql — Confirmación por Chatby: «Aceptar
-- ubicación aproximada en la calle correcta», con su prueba (MOM §6.1 y §40;
-- owner, 08-11-2026).
--
-- POR QUÉ. La guía automática del que confirmó por Chatby solo acepta de
-- Google el EDIFICIO (`ROOFTOP`, 0301). Cuando Google da el número de la
-- cuadra (`RANGE_INTERPOLATED`) el pedido queda «sin ubicación» para la
-- asesora y el punto ni se guarda (#KP204092, «Jirón José Olaya 245»,
-- Huamanga). El owner quiere probar si ese punto basta cuando además es la
-- MISMA calle, el mismo número y la misma provincia del pedido, y medirlo
-- contra donde estuvo después el motorizado.
--
-- QUÉ AGREGA (aditiva: no reescribe ninguna fila).
--   * `chatby_auto_settings.approx_mode`: Apagado / Simulación / Activo, por
--     organización. Nace `apagado` (lo de hoy). En `simulacion` se guarda el
--     punto aproximado y el pedido queda para la asesora como hoy; en
--     `activo` la guía automática lo usa.
--   * En `order_geocodes`, el punto aproximado y su veredicto:
--       - `approx_kind`: `calle` (pasó: misma calle, número y provincia) o el
--         motivo por el que no (`sin_calle`, `otra_calle`, `otro_numero`,
--         `otra_provincia`). Null: nunca se evaluó.
--       - `approx_latitude` / `approx_longitude`: solo con `calle`.
--       - `approx_mode`: la posición con que se evaluó (`simulacion`/`activo`).
--       - `approx_checked_at`: cuándo.
--       - `approx_used_at`: cuándo una guía automática se creó con él (Activo).
--     `ok`, `latitude` y `longitude` siguen siendo solo el edificio: lo que
--     ya leen los reintentos de Lima y las mediciones no cambia.
--
-- La medición (distancia al punto del motorizado) se calcula al abrir el
-- panel; no se guarda. Correrla otra vez no cambia nada.
-- ============================================================================

alter table public.chatby_auto_settings
  add column if not exists approx_mode text not null default 'apagado';
alter table public.chatby_auto_settings drop constraint if exists chatby_auto_settings_approx_mode_check;
alter table public.chatby_auto_settings add constraint chatby_auto_settings_approx_mode_check
  check (approx_mode in ('apagado', 'simulacion', 'activo'));
comment on column public.chatby_auto_settings.approx_mode is
  'Aceptar ubicación aproximada en la calle correcta (0316): apagado | simulacion | activo.';

alter table public.order_geocodes add column if not exists approx_kind text;
alter table public.order_geocodes add column if not exists approx_latitude double precision;
alter table public.order_geocodes add column if not exists approx_longitude double precision;
alter table public.order_geocodes add column if not exists approx_mode text;
alter table public.order_geocodes add column if not exists approx_checked_at timestamptz;
alter table public.order_geocodes add column if not exists approx_used_at timestamptz;

alter table public.order_geocodes drop constraint if exists order_geocodes_approx_kind_check;
alter table public.order_geocodes add constraint order_geocodes_approx_kind_check
  check (approx_kind is null or approx_kind in ('calle', 'sin_calle', 'otra_calle', 'otro_numero', 'otra_provincia'));
alter table public.order_geocodes drop constraint if exists order_geocodes_approx_mode_check;
alter table public.order_geocodes add constraint order_geocodes_approx_mode_check
  check (approx_mode is null or approx_mode in ('simulacion', 'activo'));
-- El punto solo con `calle`, y siempre los dos.
alter table public.order_geocodes drop constraint if exists order_geocodes_approx_point_check;
alter table public.order_geocodes add constraint order_geocodes_approx_point_check check (
  (approx_kind = 'calle' and approx_latitude is not null and approx_longitude is not null)
  or (approx_kind is distinct from 'calle' and approx_latitude is null and approx_longitude is null)
);

-- El panel lee los puntos aproximados de la organización, los más recientes primero.
create index if not exists order_geocodes_approx_idx
  on public.order_geocodes (store_id, approx_checked_at desc) where approx_kind = 'calle';

-- `order_geocodes` sigue sin políticas: solo la lee y escribe el servidor (0301).
