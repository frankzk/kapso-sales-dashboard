-- 0062 — Tarifas derivadas de los reportes Excel ya importados.
--
-- POR QUÉ ESTA FUENTE Y NO LA COTIZACIÓN. El Excel de Aliclik guarda la fila
-- completa en `import_rows.raw`, y ahí viene `COSTO ENTREGA`: lo que REALMENTE
-- costó ese envío. Es mejor dato que una cotización —es el cobro, no la
-- estimación—, cubre 80 distritos de golpe en vez de 60 por día, trae
-- `intento_adicional` (que su API no devuelve) y no depende de que Aliclik
-- responda: el día que se escribió esto llevaban 45 minutos devolviendo 500.
--
-- LA CLAVE QUE COSTÓ ENTENDER: `COSTO ENTREGA` NO es una tarifa, es el costo
-- REALIZADO, y depende del desenlace del envío. El mismo distrito el mismo día
-- tiene dos importes — Trujillo el 05/07 cobró S/16,50 en los 57 ENTREGADO y
-- S/9,50 en los 12 CANCELADO. Encaja con lo que su API cotiza ("Entrega S/16,50
-- · No entregado S/10,50"). Por eso cada estado alimenta un concepto distinto y
-- NO se promedian entre sí: hacerlo daba 89 de 103 distritos con "varios
-- precios" y parecía ruido cuando era señal.
--
-- Se toma la MODA y no la media: los precios se revisan (Arequipa pasó de
-- S/15,50 en junio a S/16,50 en julio) y una media entre la vieja y la nueva
-- daría un número que nunca se cobró.
create or replace function aliclik_tariffs_from_reports(p_days int default 30)
returns table (org_id uuid, district text, concept text, amount numeric, samples bigint)
language sql
stable
security definer
set search_path = public
as $$
  with filas as (
    select st.org_id,
           btrim(r.raw->>'DISTRITO')                                as district,
           upper(btrim(r.raw->>'ESTADO ENTREGA'))                   as estado,
           nullif(btrim(r.raw->>'COSTO ENTREGA'), '')::numeric      as costo,
           nullif(btrim(r.raw->>'COSTO ENTREGA ADICIONAL'), '')::numeric as adicional,
           to_timestamp(btrim(r.raw->>'FECHA CREACIÓN ALICLIK'), 'DD/MM/YYYY HH24:MI:SS') as creado
    from import_rows r
    join stores st on st.id = r.store_id
    where r.raw ? 'COSTO ENTREGA'
      and nullif(btrim(r.raw->>'DISTRITO'), '') is not null
  ),
  reciente as (
    select * from filas
    where creado is not null
      and creado >= now() - make_interval(days => p_days)
  ),
  observaciones as (
    -- Entregado: es la tarifa de la entrega efectiva.
    select org_id, district, 'primer_intento' as concept, costo as amount
    from reciente where estado = 'ENTREGADO' and costo > 0
    union all
    -- No entregado TERMINAL: es lo que cuesta el retorno. Se excluyen los
    -- estados en curso (POR ENTREGAR, NO CONTESTA, REPROGRAMADO): todavía
    -- pueden acabar entregados y su costo actual no es el definitivo.
    select org_id, district, 'devolucion', costo
    from reciente where estado in ('CANCELADO', 'RECHAZADO', 'ANULADO') and costo > 0
    union all
    -- Reintento: solo se cobra cuando hubo más de una visita, así que las filas
    -- con adicional en cero no dicen nada y no cuentan como muestra.
    select org_id, district, 'intento_adicional', adicional
    from reciente where adicional > 0
  )
  select o.org_id,
         o.district,
         o.concept,
         mode() within group (order by o.amount) as amount,
         count(*) as samples
  from observaciones o
  group by o.org_id, o.district, o.concept
  -- Una sola observación puede ser un caso raro; con tres ya hay señal.
  having count(*) >= 3;
$$;

revoke all on function aliclik_tariffs_from_reports(int) from public, anon, authenticated;
