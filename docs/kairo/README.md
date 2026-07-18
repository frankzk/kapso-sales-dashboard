# Paquete de portabilidad: módulo de Leads → Kairo.ai (Icomfly, Costa Rica)

Este directorio es la **especificación portable** del sistema de Leads de este
panel, escrita para re-implementarlo en **Kairo.ai**, donde el CRM es
**Icomfly** (no Kapso) y la operación es la tienda de **Costa Rica**.

## Cómo usar este paquete

1. **Copia la carpeta `docs/kairo/` completa al repo de Kairo.ai** (por ejemplo
   como `docs/leads-spec/`). No necesitas copiar código de este repo — la
   especificación es autosuficiente.
2. En el repo de Kairo.ai, abre una sesión de Claude Code y dile:
   > "Lee `docs/leads-spec/` e implementa el módulo de Leads siguiendo la
   > especificación, empezando por el modelo de datos y el adaptador de Icomfly."
3. Antes de eso, **responde el cuestionario de Icomfly** en
   `04-contrato-adaptador-crm.md` (§ "Qué necesitamos saber de Icomfly").
   Es la única pieza que este repo no puede darte: qué webhooks y API expone
   Icomfly. Con esas respuestas, el adaptador se escribe en un solo archivo.

## Por qué este enfoque (y no copiar el repo entero)

Auditamos el código y el acoplamiento con Kapso está **concentrado en una sola
capa**: el cliente `lib/kapso.ts`, la ruta de webhook y unas pocas columnas
`kapso_*`. Todo lo demás — modelo de datos, máquina de estados, reglas de
auto-archivado/seguimiento/drip, insights, productividad y la UI del tablero —
es **agnóstico al CRM**: solo consume formas normalizadas (`LeadSeed`,
`ConversationMessage`). La estrategia correcta es:

- **Re-implementar el núcleo portable tal cual** (documentado aquí con el
  detalle suficiente para no perder ninguna regla de negocio aprendida).
- **Escribir un adaptador Icomfly** que produzca esas mismas formas
  normalizadas (contrato en `04-contrato-adaptador-crm.md`).
- **Localizar Perú → Costa Rica** (teléfonos, moneda, zona horaria, Yape →
  SINPE Móvil): checklist en `05-checklist-costa-rica.md`.

## Contenido

| Doc | Qué contiene |
| --- | --- |
| `01-arquitectura-y-alcance.md` | Mapa del sistema, qué es portable vs. qué se reemplaza, flujo de datos |
| `02-modelo-de-datos.md` | Esquema SQL completo y portable (tablas, columnas, índices, RLS) |
| `03-maquina-de-estados.md` | Estados, categorías, transiciones y TODAS las reglas de negocio automáticas |
| `04-contrato-adaptador-crm.md` | La interfaz que el adaptador de Icomfly debe implementar + cuestionario |
| `05-checklist-costa-rica.md` | Localización CR + plan de implementación por fases |

## Referencias al código fuente original

Los documentos citan rutas de archivo de **este** repo
(`kapso-sales-dashboard`) como `lib/leads.ts:150`. Si implementas desde el repo
de Kairo.ai y necesitas ver el código original, agrega este repo a la sesión o
consulta esas rutas aquí. No es obligatorio: la spec reproduce las reglas.
