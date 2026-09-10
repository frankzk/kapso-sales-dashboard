-- ============================================================================
-- 0154_tanders_operation_number_normalize.sql — dejar los nº de operación ya
-- guardados en la forma con la que se comparan.
--
-- El nº de operación pasa a ser la clave que detecta un comprobante REUSADO:
-- el mismo pago acreditando dos pedidos. Para eso dos transcripciones del
-- mismo pago tienen que colisionar, y las 80 filas escritas antes de la regla
-- están tal como las devolvió el lector: 8 traían separadores («784.444.034.2156»,
-- «20260901109250922415288 5992»).
--
-- DOS DE ELLAS NO ERAN NÚMEROS: «202609...495099» y «2026...675». El modelo
-- elidió el medio en vez de devolver null, como se le pide. Quitarles los
-- puntos daría «202609495099», un número que no existe — y compararlo podría
-- tanto acusar en falso como tapar el duplicado de verdad. Se anulan: vale más
-- no tener dato que tener uno inventado. Es la misma regla que aplica
-- `normalizeOperationNumber` de aquí en adelante.
--
-- Comprobado al aplicarlo (10-09-2026): 78 filas con nº, ninguna sin
-- normalizar, y CERO colisiones en el histórico. Nadie había reusado un
-- comprobante hasta hoy.
-- ============================================================================

-- Lecturas truncadas: no son claves.
update tanders_payment_checks
set operation_number = null
where operation_number is not null
  and operation_number ~ '(…|\.{2,})';

-- El resto, a la forma canónica: solo letras y dígitos, en mayúsculas.
-- Nunca a número: Yape emite ceros a la izquierda («06420756») y perderlos
-- haría chocar operaciones distintas.
update tanders_payment_checks
set operation_number = upper(regexp_replace(operation_number, '[^A-Za-z0-9]', '', 'g'))
where operation_number is not null
  and operation_number <> upper(regexp_replace(operation_number, '[^A-Za-z0-9]', '', 'g'));
