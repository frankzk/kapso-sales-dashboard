-- 0195_delivered_thanks_pace.sql — ritmo del agradecimiento al entregar.
--
-- «5 mensajes cada 20 minutos.» La primera activación en Kenku encontró ~170
-- entregas pendientes dentro de la ventana de 72 h, y con el tope de 25 por
-- corrida del cron (cada 5 min) habrían salido en ~35 minutos desde un número
-- recién estrenado (Kenku 451). Meta vigila las ráfagas de marketing, y las
-- respuestas llegan todas a la vez al chat que el equipo tiene que atender.
--
-- A ese ritmo salen como mucho 15 por hora y 180 en la franja de 9 a 21 h:
-- por debajo de las 250 clientas distintas al día con que Meta suele empezar
-- un número nuevo, y por encima del volumen normal (~74 entregas al día).
--
-- Cuentan TODOS los intentos de la ventana, aceptados o no: el ritmo es el de
-- las llamadas a Meta, no el de los aciertos.

alter table stores
  add column if not exists delivered_thanks_pace_count integer not null default 5,
  add column if not exists delivered_thanks_pace_minutes integer not null default 20;

comment on column stores.delivered_thanks_pace_count is
  'Máximo de agradecimientos por ventana de delivered_thanks_pace_minutes.';
