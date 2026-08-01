# Instrucciones del repositorio

## Master Operations Map (MOM)

La fuente de verdad funcional del Master de Pedidos es
`docs/mom/master-pedidos-v1.md`.

Antes de modificar estados, macroetapas, preparación, rutas, devoluciones,
liquidaciones, pagos, permisos o cierres:

1. Lee la sección aplicable del MOM.
2. Conserva la identidad independiente de pedido y salida física.
3. Registra hechos nuevos; no sobrescribas ni elimines historial operativo.
4. Mantén Shopify como única fuente de pedidos y Kapta como fuente operativa.
5. Actualiza el MOM en el mismo cambio si la implementación modifica una regla.
6. Añade o actualiza pruebas del resolver, permisos o transición afectada.

Miro es la fuente visual. Si una captura y la especificación escrita difieren,
detén el cambio de regla y documenta la decisión aprobada en el MOM primero.
