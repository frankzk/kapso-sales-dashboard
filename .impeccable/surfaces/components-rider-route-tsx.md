---
version: 1
slug: "components-rider-route-tsx"
primary_target: "components/rider-route.tsx"
related_targets: ["components/photo-capture.tsx","components/scan-action.tsx","app/reparto/page.tsx"]
---

# Reparto del motorizado (/reparto)

Scope: la pantalla del motorizado de Grupo GF en `/reparto` (y la misma vista que abre Coordinación para reportar por él): lista de paradas, ficha de la parada con el reporte, y la evidencia (foto de la entrega, captura del Yape, foto del rechazo). Pedido por Frankz el 30-09-2026 con `/impeccable`, tras la captura de Roy con «Memoria insuficiente para completar la operación anterior». Mode: Operate.
Audience: motorizados propios (Roy, Yhoni, Duglas…) en la calle, con un Android de gama baja, datos 4G y una mano libre; a veces de noche.
Job: llegar, cobrar lo correcto, dejar evidencia y pasar a la siguiente parada sin teclear ni esperar.
Constraints: conservar reglas y validaciones (`validateStopReport`, foto obligatoria de entrega y rechazo, captura del Yape, motivo de diferencia de monto, reporte de Coordinación), la parada en la URL (`?parada=`), «atrás» cierra la ficha, dos columnas desde `lg`, texto +30 % (`rider-scale`), objetivos ≥ 48 px, sin scroll horizontal, carga ligera.
Decisions (30-09-2026, Frankz): WhatsApp se presenta como la tienda del pedido, con dos mensajes («Voy en camino», «Ya llegué»); al guardar se vuelve a la lista; la cola sin señal va en otro PR.

## Direction contract

THESIS: The rider's phone is a dispatch ticket in the hand: what to collect, where to go and the one next action, each reachable with the thumb and none needing the keyboard. It refuses the office-form arrangement where every field weighs the same and typing comes first.

OWN-WORLD: La Mesa de Despacho at street scale: white surfaces with #EBEEF1 hairlines on the slate canvas; ink #1A1B25 / #414552 / #687385; Kapta blue #1F5FE0 only for the single primary (Guardar) and for selection; outcome and status as paired tones with words (ok #D7F7C2/#006908, crit #FFE7F2/#B3063D, warn); 6px controls with the control shadow, 8px cards; stroke icons (1.8) at 20–24px; system sans with rider-scale text and tabular figures.

STORY: The rider sees how much to collect and where the stop is, navigates, messages the customer as the store or calls without typing, records the outcome in taps, attaches evidence without leaving the page (in-page camera or gallery, compressed before upload) and returns to the list.

FIRST VIEWPORT: Phone 390×844 with a stop open: sticky header (back, customer, order · district, status badge); the amount to collect as the figure; the address with its reference and copy/Waze links; a three-up action bar (Ir · WhatsApp · Llamar) at 56px; the outcome control Entregado / No entregado; the save bar fixed at the thumb with what is still missing.

FORM: Extension of an established surface inside the Mesa de Despacho world (DESIGN.md); precise request, no concept roll and no seed key.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
