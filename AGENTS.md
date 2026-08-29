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

## Ramas y despliegue

**Producción sale de `main`.** Vercel despliega esa rama, que **no** es la que la
API de GitHub devuelve como `default_branch`: esa es la rama de integración
(hoy `claude/youthful-babbage-atjexn`), y de ella solo salen previews. Leer el
`default_branch` y darlo por destino es lo que dejó la #519 mergeada, en verde y
sin llegar a producción. Si dudas, mira de dónde salen los despliegues con
`target: "production"`, no cómo se llama la rama.

El orden es este y no otro:

1. Rama de trabajo → PR contra la **rama de integración**.
2. Se mergea el PR ahí.
3. `main` avanza **solo por fast-forward** desde la rama de integración.
4. Vercel despliega producción al recibir `main`.

**Nada entra a `main` por otra vía.** El 29-08-2026 la #517 se mergeó
directamente en `main` mientras la #521 iba por la rama de integración: las dos
ramas divergieron y hubo que unirlas con un commit de merge. Tocaban ficheros
distintos y costó eso; sobre los mismos habría costado un conflicto que resolver
a ciegas, sin el autor de ninguno de los dos cambios delante.

**Desplegar no aplica migraciones.** Cada migración se corre a mano **antes** de
que salga el código que la necesita; el porqué y el comando están en
`DEPLOY.md`.
