# Kapta

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Equipos internos de confirmación, almacén, seguimiento logístico, reprogramación,
liquidaciones y dirección. Trabajan principalmente desde una computadora durante
la jornada y necesitan resolver muchos pedidos sin perder el contexto operativo.
Shopify es una herramienta cotidiana y constituye la fuente de verdad comercial.

Fuera de la oficina (confirmado el 29-09-2026):

- **Personal de almacén:** arma y escanea paquetes y recibe devoluciones, de pie,
  con una caja delante y un celular o una pistola lectora en la mano.
- **Supervisores de Grupo GF Courier:** arman las cajas del reparto propio,
  cotejan, reciben y liquidan las rutas.
- **Motorizados:** reportan cada entrega desde `/reparto` en su teléfono, en la
  calle y con una mano libre.

Los tres necesitan escanear y encontrar la siguiente acción sin desplazamiento
horizontal ni teclado abierto por defecto.

## Product Purpose

Kapta convierte cada pedido Shopify en un expediente operativo trazable. Su
objetivo es que el equipo entienda dónde está el pedido, ejecute la siguiente
acción correcta y pueda revisar evidencia e historial sin recurrir a hojas de
cálculo o conversaciones dispersas.

Hoy es una herramienta interna de las tiendas propias (Aurela y Kenku). La
intención es ofrecerla mañana a otras tiendas contra entrega del Perú; esa
oferta todavía no está definida (sin clientes externos, precio ni plan de
lanzamiento).

## Positioning

Lo que Shopify más hojas de cálculo no pueden hacer, y Kapta sí (confirmado el
29-09-2026):

1. **Un expediente único por pedido (el MOM):** un solo registro que cruza
   Shopify, couriers, motorizados, almacén y liquidaciones, con historia,
   actor y evidencia de cada paso.
2. **Control del efectivo contra entrega:** saber en cada momento quién tiene
   la caja y quién tiene la plata, y cuadrarlo contra lo que reportan couriers
   y motorizados.
3. **Reparto propio de punta a punta (Grupo GF Courier):** tomar pedidos,
   armar cajas, cotejarlas, repartir, cobrar, cerrar la ruta y pagar al
   motorizado en el mismo sistema.
4. **Conciliación con couriers externos:** cuadrar lo que declaran Aliclik,
   Tanders, Olva y los demás contra lo que pasó de verdad (entregas,
   devoluciones que no llegaron).

## Operating Context

Inferido del repositorio; corrígelo si algo cambió.

- **Tiendas:** Aurela y Kenku en Shopify, la fuente de verdad comercial.
- **Couriers:** Grupo GF Courier (motorizados propios, Lima), Aliclik
  (provincia contra entrega), Tanders, Olva, Urpi, Shalom y otras agencias.
  Cada uno reporta a su manera (API, Excel, cuaderno); Kapta concilia.
- **Operaciones:** Lima, agencia y provincia COD, con prioridad de almacén en
  ese orden y cortes de turno (10:20 mañana, 21:20 noche).
- **Documentos del día a día:** Excel de los couriers, el cuaderno de reparto
  de los motorizados en Google Sheets (Liquidaciones 2) y los rótulos con QR
  de 100 × 150 mm que acompañan cada caja.
- **Leads y confirmación** llegan por WhatsApp (Kapso).
- **Región:** Perú, soles (S/), zona horaria America/Lima, todo en español.

## Capabilities and Constraints

- **El MOM manda.** El Master Operations Map está versionado en
  `docs/mom/master-pedidos-v1.md`. Un cambio de regla de negocio actualiza el
  MOM y sus pruebas en el mismo commit; no se inventan estados que no estén
  documentados.
- **La historia no se reescribe.** Cada paso deja un evento con actor
  (`order_events`); una corrección lleva motivo y queda en el historial.
- **Una sola puerta al Master** para lo que declaran rutas y liquidaciones
  (`lib/master-door.ts`), con las mismas guardas para todas las fuentes.
- **Permisos por rol** y seguridad a nivel de fila en Supabase (RLS).
- **Solo modo claro.** El producto declara `color-scheme: light`.
- **Abierto:** cómo se separarán los datos y la configuración por tienda
  cuando haya clientes externos. Ya existe el concepto de organización
  (`org_id`), pero el modelo comercial no está decidido.

## Brand Commitments

Clara, rápida y confiable. Debe transmitir control operativo sin sentirse rígida
ni burocrática. El lenguaje visual vigente está en `DESIGN.md`.

## Evidence on Hand

- La especificación operativa completa: `docs/mom/master-pedidos-v1.md`.
- Runbooks y planes: `docs/runbooks/`, `docs/plan/`.
- Datos reales de operación en producción (Supabase).
- **No existen**, y no se deben inventar: testimonios, clientes externos,
  casos de éxito, métricas publicables ni precios.

## Product Principles

1. **Un pedido, un expediente.** Toda pantalla lee y escribe el mismo
   registro; ninguna guarda su propia versión de la verdad.
2. **La caja y la plata siempre tienen dueño.** La custodia física y el
   efectivo cambian de manos con un evento, un actor y una hora.
3. **Lo que pasó de verdad manda sobre lo declarado.** El escaneo, la parada
   y la evidencia pesan más que el reporte de un courier; la diferencia se
   muestra, no se esconde.
4. **Primero la operación propia, pensando en la ajena.** Se resuelve para
   Aurela y Kenku sin atar reglas a una tienda concreta cuando no hace falta.

## Anti-references

- Drawers largos que presentan todos los formularios con el mismo peso.
- Pantallas planas donde estados, acciones, dinero e historial usan un solo color.
- Tarjetas anidadas, ruido visual y controles que obligan a buscar la siguiente
  acción.
- Experiencias que inventan patrones desconocidos para tareas que Shopify ya
  resuelve de forma familiar.

## Design Principles

1. La tarea actual domina; el resto aparece por contexto o bajo demanda.
2. El estado se entiende antes de actuar y toda acción explica su consecuencia.
3. Las tres necesidades centrales son operar, consultar la información del
   pedido y verificar su actividad/evidencia.
4. La interfaz sigue el MOM y preserva el historial, pero no expone su complejidad
   completa en cada pantalla.
5. Los patrones familiares de Shopify sirven como referencia para navegación,
   densidad, acciones y divulgación progresiva, manteniendo la identidad de Kapta.

## Accessibility & Inclusion

Objetivo WCAG 2.1 AA: contraste suficiente, foco visible, navegación por teclado,
etiquetas que no dependan solo del color y movimiento reducido o prescindible.
El cotejo prioriza cámara en celular e ingreso por lector en escritorio.
Los controles principales tienen al menos 48 px; la navegación y los datos
secundarios se despliegan bajo demanda. El aumento de texto no debe ocultar
acciones ni depender de gestos horizontales. La pantalla del motorizado
(`/reparto`) agranda el texto un 30 % para leerla en la calle.
