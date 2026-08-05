-- 0105 — Un lead puede existir sin teléfono: identidad por BSUID.
--
-- POR QUÉ AHORA. La 0103 dejó escrito que cambiar la clave era "el paso caro y
-- riesgoso, y no compra nada hasta que exista el primer lead sin teléfono". Ese
-- día llegó y se puede fechar: durante 23 días seguidos hubo CERO conversaciones
-- sin teléfono, y a partir del 29-jul-2026 la serie fue 1, 3, 11, 16, 20, 29 —
-- ~3,5 % del volumen diario. No es un caso raro: es el rollout de identidad de
-- Meta (BSUID + username) llegando a la operación, y solo sube. Eran ~25 al día
-- que `conversationToLeadSeed` descartaba en la puerta, invisibles para todos.
--
-- CÓMO CONVIVEN LAS DOS IDENTIDADES
--
-- `unique (store_id, phone)` SE CONSERVA TAL CUAL, y no por olvido: en Postgres
-- los NULL son distintos entre sí dentro de un UNIQUE, así que con `phone`
-- nullable la restricción sigue impidiendo dos leads con el mismo teléfono y a la
-- vez permite miles de leads sin teléfono. No hace falta índice parcial.
--
-- Y NO SE USA UN ÍNDICE PARCIAL A PROPÓSITO — es una trampa real: PostgREST
-- genera `ON CONFLICT (cols) DO UPDATE` sin cláusula WHERE, y Postgres no puede
-- inferir un índice único PARCIAL como árbitro sin repetir su predicado. El
-- upsert fallaría en producción con "no unique or exclusion constraint matching
-- the ON CONFLICT specification" — y solo ahí, porque nada lo detecta antes.
-- Por eso `(store_id, bsuid)` va como UNIQUE normal: sus NULL también son
-- distintos, así que los leads con teléfono y sin BSUID conviven sin estorbarse.

alter table leads
  alter column phone drop not null;

-- Segunda identidad. Si esto falla por duplicados, hay dos leads de la misma
-- tienda con el mismo BSUID (misma persona con dos teléfonos). Se encuentran así:
--
--   select store_id, bsuid, count(*), array_agg(id)
--   from leads where bsuid is not null
--   group by 1,2 having count(*) > 1;
--
-- La fusión es una decisión de negocio (cuál conserva el historial de llamadas),
-- no algo que esta migración deba resolver a ciegas.
alter table leads
  drop constraint if exists leads_store_bsuid_key;
alter table leads
  add constraint leads_store_bsuid_key unique (store_id, bsuid);

-- El índice parcial de la 0103 queda redundante: el índice que respalda la
-- restricción de arriba ya sirve la búsqueda por (store_id, bsuid).
drop index if exists leads_store_bsuid;

-- Un lead sin NINGUNA identidad no se puede contactar ni deduplicar: sería una
-- fila huérfana que ninguna sincronización posterior podría volver a encontrar.
alter table leads
  drop constraint if exists leads_identidad_presente;
alter table leads
  add constraint leads_identidad_presente
  check (phone is not null or bsuid is not null);

-- La cola se sigue ordenando y filtrando igual; lo único nuevo es poder listar
-- los que no tienen teléfono, que son los que necesitan una acción distinta
-- (escribir por WhatsApp para pedir el número, en vez de llamar).
create index if not exists leads_store_sin_telefono
  on leads (store_id, last_interaction_at desc)
  where phone is null;
