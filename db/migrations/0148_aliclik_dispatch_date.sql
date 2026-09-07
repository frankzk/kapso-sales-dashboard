-- La fecha de despacho de Aliclik: la que debería ser y la que pusieron.
--
-- EL CASO. La guía AUR5X846640592825 (#KP123403) se creó el sábado 29-08-2026 a
-- las 14:13 de Lima —trece minutos pasada la hora de corte— y Aliclik la fechó
-- para el DOMINGO 30. Aliclik no recoge domingos, así que el lunes el motorizado
-- ve una fecha vencida y se niega a llevarse el paquete. La operación acaba
-- entrando a su portal a corregirlo a mano, guía por guía.
--
-- Y NO ES UNA FUNCIONALIDAD QUE FALTE: es su regla incumplida. Su propia
-- documentación, en las reglas de negocio de `POST /integration/order`, dice
-- «Courier estándar: la fecha de despacho se calcula contra `schedule`. Si cae
-- en domingo, se desplaza al lunes.» El primer paso lo hicieron; el segundo no.
--
-- POR QUÉ DOS COLUMNAS Y NO UNA. Son dos hechos distintos y mezclarlos destruye
-- lo único que hace accionable esto:
--
--   * `aliclik_expected_dispatch_date` — lo que su regla manda, calculado por
--     nosotros al crear la guía, con el `schedule` que su propia cotización nos
--     dio para ese courier y ese almacén.
--   * `aliclik_reported_dispatch_date` — la columna «FECHA DESPACHO» de su
--     Excel, o sea lo que efectivamente pusieron.
--
-- Su diferencia es la cifra con la que se reclama. Guardar solo una dejaría la
-- conversación en «nos pasa a veces», que es justo lo que lleva meses pasando.
--
-- LO QUE ESTAS COLUMNAS NO SON. No cambian la guía: Aliclik no admite fecha en
-- la creación de contra entrega —su esquema no la tiene— así que el paquete
-- sigue llevando lo que ellos decidan. Esto sirve para avisar antes de crear y
-- para contar después. Corregir la guía sigue siendo manual hasta que arreglen
-- su cálculo.
--
-- NO SE TOCA `aliclik_service_date`, que guarda la fecha de entrega/visita del
-- reporte. Es otro hecho y reutilizarla habría hecho ambiguas las dos.

alter table shipments
  add column if not exists aliclik_expected_dispatch_date date,
  add column if not exists aliclik_reported_dispatch_date date;

comment on column shipments.aliclik_expected_dispatch_date is
  'Fecha de despacho que corresponde según la regla de Aliclik (corte del courier; domingo → lunes), calculada al crear la guía. Ver lib/aliclik-dispatch-date.ts.';
comment on column shipments.aliclik_reported_dispatch_date is
  'Fecha de despacho que Aliclik reporta en su Excel (columna FECHA DESPACHO). Comparada con la esperada, delata los incumplimientos de su propia regla.';

-- Para contar los incumplimientos sin recorrer la tabla entera. Parcial: solo
-- interesan las guías que tienen las dos fechas y difieren, que son unas pocas
-- entre miles.
create index if not exists shipments_dispatch_date_mismatch_idx
  on shipments (aliclik_expected_dispatch_date, aliclik_reported_dispatch_date)
  where aliclik_expected_dispatch_date is not null
    and aliclik_reported_dispatch_date is not null
    and aliclik_expected_dispatch_date <> aliclik_reported_dispatch_date;
