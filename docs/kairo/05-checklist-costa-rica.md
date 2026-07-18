# 05 · Localización Costa Rica + plan de implementación

## Localización Perú → Costa Rica

| Aspecto | Perú (original) | Costa Rica (Kairo) |
| --- | --- | --- |
| Código de país | `51` + 9 dígitos móviles (`9XXXXXXXX`) | `506` + **8 dígitos** (móviles inician en `6`, `7`, `8`) |
| Normalización | `lib/phone.ts`: strip no-dígitos, quita `00`, antepone `51` a `9XXXXXXXX` | Igual patrón: strip no-dígitos, quita `00`, antepone `506` a 8 dígitos que inicien en 6/7/8; validar contra el formato que emita Icomfly (cuestionario doc 04, pregunta 4) |
| Moneda | `S/` (PEN) — regex de totales `ORDER_TOTAL_RES` anclan en "S/", "total", "a pagar" | `₡` (CRC) — reescribir regex para `₡`, "colones", montos con separador de miles `.` o `,` según cómo escriba el bot. `stores.currency = 'CRC'` |
| Zona horaria | `America/Lima` (UTC-5) | `America/Costa_Rica` (UTC-6). ⚠️ El original tiene Lima en 3 sitios: horario del drip (9–20), turnos de insights (8–20) y cron de Telegram (13:00 UTC = 08:00 Lima → para CR sería 14:00 UTC). Parametrizar por `stores.timezone` desde el día 1 |
| Pago adelantado | **Yape** (detección texto + visión de vouchers + rotación) | **SINPE Móvil**: renombrar estado a `sinpe_por_verificar`, reescribir regex ("sinpe", "ya le hice el sinpe", "transferí"), la visión de vouchers funciona igual (captura de comprobante SINPE) |
| Ubicación | Distrito (Lima) — pregunta del bot | Cantón/distrito CR — revisar cómo pregunta el bot de Kairo y ajustar los patrones de extracción |
| Envíos | Contraentrega Lima / agencia provincias | Adaptar a la logística de Kairo (Correos de CR, mensajería GAM, etc.) — solo afecta etiquetas y el split `pago`/`agencia` |

## Plan de implementación por fases

Cada fase termina en algo usable. Con Claude Code en el repo de Kairo,
la Fase 1–2 es aproximadamente una sesión de trabajo cada una.

### Fase 0 — Descubrimiento de Icomfly (bloqueante, hazlo tú)
- [ ] Responder el cuestionario del doc 04 (API, webhooks, envío, media,
      formato de teléfono, referral CTWA).
- [ ] Capturar **payloads reales** de Icomfly (un webhook de cada tipo, una
      respuesta de su API de conversaciones/mensajes) y guardarlos como
      fixtures — los normalizadores se testean contra eso.
- [ ] Decidir nivel de servicio objetivo (A/B/C del doc 04).

### Fase 1 — Núcleo: datos + ingesta + tablero mínimo
- [ ] Migraciones del doc 02 (leads, lead_calls, conversations,
      webhook_events, RLS).
- [ ] Normalizador de teléfono CR + tests.
- [ ] Adaptador Icomfly: `listConversations` + `conversationToLeadSeed`
      (o solo webhook, según nivel).
- [ ] Cron `/api/cron/sync` con `syncStoreLeads` + `nextLeadState`
      (las 4 leyes del doc 03).
- [ ] Tablero: lista con pestañas, búsqueda, `registerCall` con el catálogo
      de estados, `claimLead` con TTL.
- **Criterio de salida**: un lead real de Icomfly aparece en el tablero,
  se gestiona y el estado manual sobrevive al siguiente sync.

### Fase 2 — Reglas automáticas + seguimientos
- [ ] `flagOverdueFollowups`, `defaultFollowupAt` (18:00/10:00 hora CR).
- [ ] `archiveStaleLeads` 7 días **con las 3 exclusiones** (doc 03 🔥).
- [ ] `flagCartAttentionWaves` (si hay señal de carrito).
- [ ] Enlace órdenes→leads por teléfono (si la tienda de Kairo lo permite).
- [ ] Resumen diario Telegram.

### Fase 3 — Chat embebido + envío (nivel B/C)
- [ ] Transcript en el drawer (lectura en vivo, no persistir mensajes).
- [ ] Proxy de media con allowlist de hosts Icomfly.
- [ ] Composer + `whatsapp_outbox` + webhook de estados + reintentos.
- [ ] Ventana 24h (`last_inbound_at`) con colores de urgencia.

### Fase 4 — Enriquecimiento + pagos + insights
- [ ] Parsers: cantón/distrito, carrito (₡), SINPE por texto.
- [ ] Visión de vouchers SINPE (opcional; requiere API key de Anthropic).
- [ ] Rotación de `sinpe_por_verificar` + alerta Telegram fuera de horario.
- [ ] Drip de plantillas (2 toques, 6h/24h, horario CR, cap 25/corrida).
- [ ] Insights (burndown, tendencia, conversión) + productividad.
- [ ] Atribución Meta CTWA si corren anuncios.

## Consejos de traslado (lo que evita re-aprender a golpes)

1. **No persistas mensajes** — solo metadatos de conversación. El transcript
   se lee del CRM al abrir el drawer. Evita una tabla gigante y problemas de
   sincronización.
2. **Estados manuales intocables** para la ingesta. Es la regla nº 1; sin
   ella el sync pisa el trabajo de las vendedoras y pierden confianza en el
   tablero.
3. **Idempotencia en todo webhook** desde el día 1 (los CRM re-entregan).
4. **Las exclusiones del auto-archivado** (pagos por verificar, seguimiento
   programado, needs_attention) salieron de bugs reales — no las omitas.
5. **Fixtures de payloads reales** de Icomfly antes de escribir el
   normalizador; los CRMs cambian formas de timestamp/dirección sin avisar.
6. **Parametriza timezone y moneda por tienda** aunque Kairo sea mono-tienda:
   es lo que permitió a este panel absorber tiendas nuevas sin tocar código.
7. Puertos con tests en el original que conviene replicar: máquina de
   estados, normalización de teléfono, parsers de carrito/distrito,
   verificación HMAC/secreto de webhooks, idempotencia de re-entregas.
