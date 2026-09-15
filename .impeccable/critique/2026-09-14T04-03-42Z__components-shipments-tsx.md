---
target: components/shipments.tsx
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 3
target_identity: "file:/home/user/kapso-sales-dashboard/components/shipments.tsx"
target_fingerprint: "sha256:8c8690c1f86e67090915c334218b113ee7e0ab4fd74641b420ee47ce160bfd52"
target_path: /home/user/kapso-sales-dashboard/components/shipments.tsx
timestamp: 2026-09-14T04-03-42Z
slug: components-shipments-tsx
---
Method: dual-agent (A: revisión de diseño · B: detector + greps).

## Design Health Score

| # | Heurística | Puntaje | Problema clave |
|---|---|---|---|
| 1 | Visibilidad del estado | 3 | Una lectura fallida de la cola se pinta igual que un día terminado |
| 2 | Sistema ↔ mundo real | 3 | Un contador con dos nombres: «Intento 3» y «Llamadas 3 / 7» |
| 3 | Control y libertad | 2 | La guarda de borrador promete «se descarta» y no descarta; `n` la esquiva |
| 4 | Consistencia | 3 | `SwaypNoveltyModal` queda fuera de `useDialogKeys` |
| 5 | Prevención de errores | 2 | La nota y la fecha de una guía sobreviven a la siguiente |
| 6 | Reconocer antes que recordar | 3 | «Siguiente →» no dice a quién abre; leyenda de atajos solo en escritorio |
| 7 | Flexibilidad y eficiencia | 3 | `j`/`k` recorren 5.000 filas sobre un DOM de 200 |
| 8 | Estética y minimalismo | 2 | Seis controles en «Gestión»; «· Fuera de cobertura» rojo en entregadas |
| 9 | Recuperación de errores | 3 | Todo tiene captura y reintento menos la lectura de la cola |
| 10 | Ayuda y documentación | 2 | La documentación operativa vive en comentarios que la operación no lee |
| **Total** | | **26/40** | **Aceptable** |

Tendencia: 22 → 25 → 28 → 24 → 26.

## Veredicto de especificidad

Sin ambigüedad, está diseñado para este producto, y la evidencia es estructural:
«Ruta sugerida» releer la máquina de estados por fila y nombra por qué se cerró
la ventana Aliclik; el badge lleva la gramática de dos mitades del MOM §11; el
formulario sabe que «confirma» es un acto de acuñación que estampa una fecha en
un número de guía. Las fallas son de este diseño contra sus propias reglas.

## Escaneo determinista

Detector: exit 0, `[]`, con control de 8 hallazgos en otros archivos — el cero
tiene respaldo. Mejoras medidas: 33 de 33 controles etiquetados (antes faltaban
3); `title=` como único portador de 8 a 4; cero hex crudos; un solo token bajo
500 en texto y es `aria-hidden`; las seis constantes se usan como símbolos.

## Problemas prioritarios

### [P0] La nota y la fecha de un cliente se van con el siguiente
`setNote("")` y `setNextDate("")` no existen en el archivo y nunca existieron
(`git log -S`). `registerRerouteCall` no lleva `onSuccess`, a diferencia de las
otras cuatro acciones. El cajón no se remonta entre guías (sin `key`), así que
los 39 `useState` sobreviven. «Descartar y seguir» no descarta: la guía B abre
con la nota y la fecha de A y el botón habilitado. Además la guarda grita en
falso en cada «Siguiente» del camino feliz, que enseña a ignorarla.

### [P0] La regla del MOM §11.7 nunca se ejecuta
`status_category !== "cancelled"` (`:1606`, `:2502`): esa categoría no existe
—son `pending|in_route|delivered|closed|transferred`—, la condición es siempre
verdadera y la rama está muerta. La regla de «la ausencia se escribe» no se
imprime nunca. Y la celda de escritorio no tiene guarda, así que una guía Swayp
nativa sin intento previo muestra «sin motivo del courier · no consta si la
rechazó en la puerta» bajo «Motivo anterior».

### [P1] El atajo `n` esquiva la guarda y la liberación de reserva
`setOpenId` crudo (`:657-663`) contra `handleOpenShipment` del botón (`:2353`).

### [P1] Una carga fallida de la cola es idéntica a un día terminado
`if (page.error) break;` (`shipments-access.ts:625`) y el mismo texto gris.

### [P1] La reserva es una cortesía, no un candado
Ninguna acción de escritura lee `claimed_by`. El modo perezoso deja además el
`fieldset` habilitado mientras `claimState === "claiming"`.

### [P2] «Siguiente» ignora `claimedBy`, y `j`/`k` mueren pasada la fila 200

## Banderas por persona
Alex: cada afordance de teclado que se le enseña es el degradado.
Sam: `SwaypNoveltyModal` es trampa de teclado, sin rol, sin Escape, con emoji.
Mariannys: es a quien le pega el P0; dos paneles compiten por la misma llamada.

## Observaciones menores
Un contador con dos nombres · `hasDraft` no cuenta las fechas · «Swayp» 90 veces
como literal mientras el dato es `fenix` · «Fuera de cobertura» rojo en
entregadas · tres banderas de confirmación que son un concepto ·
`fmtShortDate` compara año UTC contra local · `handleDirectGuideModalClosed`
borra el filtro de tienda que `survivesViewChange` protege.
