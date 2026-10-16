-- ============================================================================
-- 0258_restock_reply_sweep.sql — barrido de respuestas al recordatorio de
-- reposición (MOM §34, 15-10-2026).
--
-- El 14-10-2026 el número 451 no tenía el webhook de «mensaje recibido» en
-- Kapso: 11 clientas contestaron el recordatorio y Kapta no se enteró. El
-- barrido revisa, con la API de Kapso, la conversación de quien escribió
-- después de su recordatorio y todavía no tiene respuesta registrada.
-- `reply_checked_at` es la última vez que se revisó: solo se vuelve a mirar
-- si la clienta escribió algo después.
-- ============================================================================

alter table restock_sends
  add column if not exists reply_checked_at timestamptz;
