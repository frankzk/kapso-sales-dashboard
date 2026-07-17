-- ============================================================================
-- 0036_attention_waves.sql — contador de "olas" de reencolado automático por
-- lead. Un CARRITO en seguimiento cuyo último resultado fue "no logré
-- contactar" (no_responde/buzon/cuelga) y lleva 48h sin actividad vuelve a
-- subir con needs_attention — máximo 2 veces (ola 1 ≈ día 2, ola 2 ≈ día 4).
-- Sin tope sería un ping-pong infinito: cada gestión apaga la atención y
-- reinicia el reloj de 48h. Tras la ola 2, o la asesora agenda/dispone, o el
-- auto-archivado de 7 días lo saca. Los estados de "sí hablé" (contactado,
-- otros productos) y los cierres (cancelado, solo miraba…) NUNCA se reencolan.
-- ============================================================================

alter table leads add column if not exists attention_waves int not null default 0;
