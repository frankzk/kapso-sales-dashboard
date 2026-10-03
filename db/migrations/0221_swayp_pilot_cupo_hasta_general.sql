-- 0221_swayp_pilot_cupo_hasta_general.sql — el cupo diario del piloto sin
-- historial (MOM §11.9.1) puede subir por encima de 3, hasta el cupo general.
--
-- POR QUÉ (03-10-2026, decisión del owner). La 0210 fijó el cupo del piloto
-- con `check (pilot_daily_cap between 1 and 3)`: subirlo exigía una migración
-- aunque §11.9 dice que los topes se configuran en la base. Tras ampliar el
-- piloto a 14 días y 0–2 intentos (0220) el owner lo sube a 6.
--
-- QUÉ CAMBIA. El tope del piloto queda entre 1 y el cupo general
-- (`daily_cap`, hoy 10): el piloto siempre se cuenta dentro del máximo general,
-- así que un valor mayor no tendría efecto y solo confundiría la pantalla. La
-- reserva (`swayp_emission_claim`) ya lee el valor de la tabla y no cambia.

alter table swayp_auto_settings drop constraint if exists swayp_auto_settings_pilot_daily_cap_check;
alter table swayp_auto_settings add constraint swayp_auto_settings_pilot_daily_cap_check
  check (pilot_daily_cap >= 1 and pilot_daily_cap <= daily_cap);
