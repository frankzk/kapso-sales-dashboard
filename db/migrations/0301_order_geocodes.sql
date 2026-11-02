-- ============================================================================
-- 0301_order_geocodes.sql — la coordenada por dirección (Google) para la guía
-- automática de Provincia COD (MOM §6.1 y §38, owner 02-11-2026).
--
-- QUÉ. Cuando el pedido que confirmó por Chatby no trae coordenada y la
-- clienta no mandó su ubicación por WhatsApp, la guía automática prueba la
-- dirección escrita en la Geocoding API de Google. Solo vale el punto que pasa
-- el candado (lib/geocode-google.ts) Y que Google da por el EDIFICIO
-- (`ROOFTOP`): en el piloto de Kenku (02-11-2026) fue el 92,7 % a 300 m o menos
-- del pin real en Provincia COD, sobre el 90 % que pidió el owner.
--
-- POR QUÉ UNA TABLA. La pasada vuelve a mirar el mismo pedido cada 30 minutos
-- mientras espera la ubicación; sin guardar la respuesta, cada vuelta gastaría
-- otra consulta del cupo diario (400). Se guarda una fila por pedido con la
-- huella de la dirección consultada: si la dirección cambia, se vuelve a
-- consultar; si no, se usa lo guardado. Los errores de la API y el cupo
-- agotado NO se guardan: se reintentan.
--
-- NO es la coordenada del pedido: no toca `order_master.latitude/longitude`
-- ni `order_geo_overrides`. La guía que se crea con ella guarda su punto como
-- la del botón.
--
-- El interruptor `chatby_auto_settings.geocode_enabled` (por organización, nace
-- encendido porque lo pidió el owner) apaga solo esto, sin tocar el resto de
-- la pasada.
-- ============================================================================

create table if not exists order_geocodes (
  order_id      uuid primary key references orders(id) on delete cascade,
  store_id      uuid not null references stores(id) on delete cascade,
  -- Huella (sha256) de lo que se le mandó a Google: calle, distrito, provincia, departamento.
  address_hash  text not null,
  ok            boolean not null,
  -- ROOFTOP / RANGE_INTERPOLATED cuando pasó el candado.
  precision     text,
  latitude      double precision,
  longitude     double precision,
  -- Por qué no pasó (impreciso, coincidencia_parcial, distrito_distinto…).
  reason        text,
  checked_at    timestamptz not null default now()
);

alter table order_geocodes enable row level security;
-- Sin políticas: solo la lee y escribe el servidor (service role).

alter table chatby_auto_settings add column if not exists geocode_enabled boolean not null default true;
