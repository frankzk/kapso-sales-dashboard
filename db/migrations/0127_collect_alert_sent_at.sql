-- 0127 — Cuándo se avisó de que una guía va a cobrar de más.
--
-- POR QUÉ. La 0060 ya guarda `reported_collect_amount`: lo que el courier
-- DECLARA que va a cobrar en la puerta, refrescado por el cron cada 20 minutos.
-- Su cabecera decía que persistirlo «convierte esa pasada en un detector
-- permanente» — pero el detector nunca se conectó. `collectAmountMismatch`
-- existe, está probado, y hasta hoy solo lo llamaba su propio test. O sea que
-- el dato se recogía y nadie lo miraba.
--
-- Conectarlo exige exactamente una cosa que no había: memoria de a quién ya se
-- avisó. Sin ella, un cron que corre cada 20 minutos repite la misma alerta
-- para el mismo pedido hasta que alguien lo entrega — y una alerta que se repite
-- setenta veces deja de leerse, que es la forma más cara de tener un detector.
--
-- Misma solución que `leads.yape_alert_sent_at`, del que esto es hermano: se
-- marca cuándo se avisó y se re-avisa como mucho cada N horas mientras el
-- descuadre siga vivo. Se re-avisa, y no una sola vez, porque el problema no se
-- resuelve solo: hay dinero a punto de cobrarse dos veces y alguien tiene que
-- ir al panel del courier.

alter table shipments
  add column if not exists collect_alert_sent_at timestamptz;

comment on column shipments.collect_alert_sent_at is
  'Última vez que se avisó por Telegram de que esta guía cobra un importe que no '
  'corresponde (ver lib/collect-alert.ts). NULL = nunca avisada. Solo controla la '
  'repetición del aviso: el descuadre se decide en cada pasada con el dato fresco.';

-- El barrido pregunta "guías vivas con importe declarado", que es una fracción
-- pequeña de la tabla. El índice parcial lo resuelve sin recorrerla entera.
create index if not exists shipments_collect_alert_idx
  on shipments (store_id, collect_alert_sent_at)
  where reported_collect_amount is not null;
