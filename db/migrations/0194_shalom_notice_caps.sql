-- 0194_shalom_notice_caps.sql — tope de avisos de Shalom/Olva por tienda.
--
-- QUÉ LIMITA. Los avisos que Kapta manda POR SU CUENTA desde la cola de
-- `shalom_transit_notifications`: tránsito y llegada, de Shalom y de Olva. Un
-- tope por día (ventana móvil de 24 h, que es como mide Meta) y otro por hora
-- para que no salgan todos juntos a la primera pasada del cron.
--
-- POR QUÉ. El 28-09-2026 WhatsApp bloqueó el 600 —el número de cobranza, desde
-- el que salían estos avisos— y el 630. El 600 venía mandando entre 50 y 75
-- plantillas al día a clientas que nunca le habían escrito. El número que los
-- reemplace es nuevo, y un número nuevo tiene que empezar despacio.
--
-- QUÉ NO LIMITA. Las respuestas a lo que la clienta escribe (botones, acuses,
-- la clave al validar): van dentro de la ventana de 24 h que ella abrió, no
-- las cuenta el límite de Meta y cortarlas sería dejarla hablando sola. Y los
-- carritos, el winback y demás: salen por otro número y se decidió dejarlos
-- fuera de este tope.
--
-- AL LLEGAR AL TOPE el aviso NO se pierde: se queda en la cola y sale en la
-- siguiente pasada con cupo. Topes conservadores de nacimiento; se suben desde
-- Ajustes a medida que el número gane calidad.

alter table stores
  add column if not exists shalom_notice_daily_cap  integer not null default 30
    check (shalom_notice_daily_cap between 0 and 1000),
  add column if not exists shalom_notice_hourly_cap integer not null default 8
    check (shalom_notice_hourly_cap between 0 and 1000);

comment on column stores.shalom_notice_daily_cap is
  'Máximo de avisos de Shalom/Olva enviados en 24 h móviles. 0 = ninguno. '
  'Al llegar al tope el aviso espera en la cola, no se pierde.';
comment on column stores.shalom_notice_hourly_cap is
  'Máximo de avisos de Shalom/Olva enviados en la última hora, para repartirlos '
  'a lo largo del día. 0 = ninguno.';
