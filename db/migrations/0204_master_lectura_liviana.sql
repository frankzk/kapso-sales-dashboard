-- ============================================================================
-- 0204_master_lectura_liviana.sql — que el Master deje de recargarse por cosas
-- que no cambiaron, y que leerlo cueste lo que tiene que costar.
--
-- LO QUE SE MIDIÓ (29-09-2026, 08:00–09:00 de Lima, horario de trabajo):
--
--   * 161 pedidos con un evento real en la hora, y 2.298 filas del Master
--     reescritas: catorce veces más reescrituras que cambios.
--   * De 741 guías de Aliclik tocadas en dos horas, 729 solo recibieron el
--     sello de lectura de la API (`api_report_at`). `last_report_at` no se movió
--     en ninguna: Aliclik manda su `updatedAt` y el sello se escribe igual.
--   * La cadena: el barrido de Aliclik (cada 20 min) sella la lectura →
--     `shipments_touch` sube `shipments.updated_at` → `order_master_stale` da el
--     pedido por desfasado (MOM §19.1) → el barrido del Master (cada 10 min) lo
--     recalcula y hace upsert → `order_master_touch` sube `updated_at` → el
--     sondeo de cada pestaña del Master ve una ficha distinta y recarga la
--     página entera. Con una docena de pestañas abiertas, casi cada 45 s.
--
-- `lib/aliclik-snapshot-diff.ts` ya había decidido, el 10-09, que un sello de
-- lectura dice CUÁNDO miramos y no QUÉ vimos, y que no merece un recálculo. La
-- regla se cumplía en el camino directo y se perdía por la puerta de atrás: el
-- trigger convertía el sello en «la guía cambió», y el detector de desfase hacía
-- el recálculo que el barrido se había ahorrado. Esta migración lleva la misma
-- regla a la base, que es donde el detector la lee.
--
-- Y de paso, tres lecturas que pagaba cada persona conectada:
--
--   * La política de motorizados (0186) evaluaba `auth_rider_order_ids()` en
--     CADA lectura del Master de CADA usuario, sea o no motorizado: 3–84 ms por
--     consulta medidos. Con la guarda de abajo, quien no es motorizado paga una
--     búsqueda por índice (<1 ms) y la lista de paradas no se construye.
--   * La búsqueda del Master: con RLS, `ilike` no es «leakproof» y Postgres no
--     puede usar los índices trigram (0069) antes de la política. Cada búsqueda
--     recorría las 26.000 filas: 160–245 ms, dos veces por búsqueda (conteo y
--     página). La misma consulta con el índice tarda ~34 ms.
--   * Los dos índices de `recomputed_at`. Medido: `order_master_stale` tarda
--     115 ms SIN el índice (recorrido + orden) y 318 ms CON él. No ayudaban, y
--     como `recomputed_at` cambia en cada recálculo, impedían que la base
--     reescribiera la fila en su sitio (HOT): cada recálculo tocaba los 36
--     índices de la tabla. 6,3 millones de actualizaciones desde junio, 0,04 %
--     en su sitio.
-- ============================================================================

-- ⚠️ AL APLICAR ESTO EN PRODUCCIÓN, LEE ESTO PRIMERO.
--
-- Mejor al final del día. Los `drop index` y el cambio de triggers toman un
-- bloqueo corto sobre `order_master` y `shipments`: esperan a que terminen las
-- consultas en curso y, mientras esperan, frenan las nuevas. Es cuestión de
-- segundos, pero no a media mañana. Si quieres evitarlo del todo, borra antes
-- los índices en su forma concurrente, que no bloquea, y luego corre el fichero
-- (los encontrará borrados y se los saltará):
--
--   drop index concurrently if exists public.order_master_recomputed_idx;
--   drop index concurrently if exists public.order_master_store_recomputed_idx;
--
-- (`concurrently` no puede ir dentro de una transacción y por eso no está escrito
-- así acá: db/apply.sql aplica las migraciones en bloque y fallaría.)
--
-- Y aplícala ANTES de desplegar el código que la usa. Si el código sale primero,
-- la búsqueda vuelve sola al camino anterior (lento pero correcto) hasta que la
-- función exista: ver `getOrderMasterPage`.

-- ── 1. Guías: un sello de lectura no es un cambio de la guía ───────────────────
--
-- `api_report_at` y `api_updated_at` son los sellos de lectura de la API
-- (0111, 0117): cuándo la miramos y qué `updatedAt` vimos. Una actualización que
-- solo toca eso deja `updated_at` como estaba. Cualquier otra columna distinta,
-- aunque la escriba una consola de SQL, sigue moviéndolo: la regla de §19.1 no
-- cambia, cambia qué cuenta como escritura de la guía.
--
-- `last_report_at` NO entra en la lista a propósito, aunque
-- `lib/aliclik-snapshot-diff.ts` también lo llame sello: lo escriben el Excel,
-- Olva y Tanders, y los barridos de Olva y Shalom eligen qué guía leer después
-- ordenando por `updated_at`. Si ese sello dejara de moverlo, esos barridos se
-- quedarían releyendo siempre las mismas. Y no hace falta: Aliclik no lo mueve
-- en sus relecturas (0 de 741 medidas).
create or replace function public.shipments_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  if (to_jsonb(new) - array['updated_at', 'api_report_at', 'api_updated_at'])
     is not distinct from
     (to_jsonb(old) - array['updated_at', 'api_report_at', 'api_updated_at']) then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end
$$;

-- `create or replace trigger` y no drop + create: el cambio es atómico, sin un
-- instante en que la tabla se quede sin trigger.
create or replace trigger shipments_touch before update on public.shipments
  for each row execute function public.shipments_touch_updated_at();

-- ── 2. Master: un recálculo que no cambia nada no es un cambio ─────────────────
--
-- `recomputed_at` dice cuándo se recalculó; `updated_at`, cuándo cambió lo que
-- la fila dice. Hasta acá eran lo mismo, y por eso el sondeo del Master veía un
-- cambio en cada recálculo aunque el pedido siguiera igual. Ahora `updated_at`
-- solo se mueve si cambió alguna otra columna.
--
-- `order_master_coverage` corre antes que este trigger (orden alfabético), así
-- que la cobertura que él resuelva ya está en `new` al comparar.
create or replace function public.order_master_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  if (to_jsonb(new) - array['updated_at', 'recomputed_at'])
     is not distinct from
     (to_jsonb(old) - array['updated_at', 'recomputed_at']) then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end
$$;

create or replace trigger order_master_touch before update on public.order_master
  for each row execute function public.order_master_touch_updated_at();

-- Sin índices sobre `recomputed_at`, un recálculo que no cambia nada modifica
-- una sola columna sin índice y la base puede reescribir la fila en su sitio
-- (HOT), sin tocar ningún índice. Para eso necesita hueco en la página: el 90 %
-- deja un 10 % libre en las páginas que se escriban desde ahora.
--
-- `order_master_stale` sigue recorriendo del recálculo más viejo al más nuevo
-- (MOM §19.1): solo cambia cómo, y medido es más rápido.
drop index if exists public.order_master_recomputed_idx;
drop index if exists public.order_master_store_recomputed_idx;
alter table public.order_master set (fillfactor = 90);

-- ── 3. Política de motorizados: que solo la pague el motorizado ───────────────
--
-- Mismo alcance que 0186: el motorizado lee las filas de sus rutas en curso o
-- cerradas, y nada más. La guarda `(select auth_rider_id()) is not null` se
-- evalúa una vez por consulta; si es falsa, la lista de paradas ni se arma.
-- `alter policy`: la política de 0186 cambia de expresión en el sitio, sin un
-- instante en que el motorizado se quede sin ella.
alter policy order_master_select_rider on public.order_master
  using ((select public.auth_rider_id()) is not null and order_id in (select public.auth_rider_order_ids()));

-- ── 4. Búsqueda del Master que sí usa sus índices ──────────────────────────────
--
-- SECURITY DEFINER para que el `ilike` llegue a los índices trigram sin pasar
-- por la política. El alcance se impone acá, explícito: solo las tiendas que
-- quien llama puede ver (`auth_store_ids()`, la misma regla de
-- `order_master_select`), cruzadas con las que pide. Nunca devuelve más de lo
-- que la RLS le dejaría leer; al motorizado, que no tiene tiendas, nada.
--
-- El término se busca LITERAL: `%`, `_` y `\` se escapan, así que una guía con
-- guion bajo no se convierte en comodín. Orden, página y conteo los pone quien
-- llama (PostgREST) sobre el resultado.
create or replace function public.order_master_search(p_store_ids uuid[], p_term text)
returns setof public.order_master
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_term text := btrim(coalesce(p_term, ''));
  v_pattern text;
begin
  if v_term = '' or coalesce(array_length(p_store_ids, 1), 0) = 0 then
    return;
  end if;
  v_pattern := '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return query
    select om.*
      from public.order_master om
     where om.store_id = any(p_store_ids)
       and om.store_id in (select public.auth_store_ids())
       and (om.order_name ilike v_pattern
         or om.guide_code ilike v_pattern
         or om.customer_phone ilike v_pattern
         or om.customer_name ilike v_pattern);
end
$$;

revoke all on function public.order_master_search(uuid[], text) from public, anon;
grant execute on function public.order_master_search(uuid[], text) to authenticated, service_role;

comment on function public.order_master_search(uuid[], text) is
  'Búsqueda del Master (pedido, guía, teléfono, cliente) con índices trigram, acotada a las tiendas de quien llama.';
