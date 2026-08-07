// Reconciliación entre la guía creada por API y la fila que trae luego el Excel.
// Puro + testeado.
//
// EL PROBLEMA. Aliclik tiene DOS identificadores para el mismo envío físico:
//
//   * `orderNumber` — "ALC000123456789". Lo devuelve la API al crear y es la
//     clave con la que llegan los webhooks.
//   * el código de guía — "AUR5X…". Es el que aparece en el reporte Excel, el
//     que va impreso en el paquete y el que el equipo busca. Es el que vive en
//     `shipments.guide_code`, único por courier (0022).
//
// Al crear por API solo conocemos el primero, así que se guarda en `guide_code`
// de forma PROVISIONAL (además de en `external_order_number`). Cuando después se
// importa el Excel, esa misma guía llega otra vez con su AUR5X… Si no hiciéramos
// nada, el upsert por (courier, guide_code) crearía una SEGUNDA fila: dos guías
// para un solo envío, y el Master contando dos intentos y dos couriers.
//
// LA SOLUCIÓN: promover. Antes de que corra el upsert normal, se renombra el
// `guide_code` de la fila existente de ALC… a AUR5X… Como la fila AUR5X aún no
// existe, el UPDATE no puede chocar, y la fila conserva sus llamadas
// (`shipment_calls`), su vínculo al pedido, su reclamación y su historial.
//
// Este módulo solo DECIDE las promociones. Ejecutarlas es cosa de
// lib/aliclik-ingest.ts.

import { normalizeOrderName } from "@/lib/aliclik-import";
import { normalizePhone } from "@/lib/phone";

/** Una guía que creamos nosotros por API y que sigue con código provisional. */
export interface ApiCreatedGuide {
  id: string;
  store_id: string;
  /** Código provisional, hoy = external_order_number. */
  guide_code: string;
  external_order_number: string | null;
  order_id: string | null;
  order_name: string | null;
  customer_phone: string | null;
  delivery_status: string;
  created_at?: string | null;
}

/** Una fila del reporte importado, ya parseada. */
export interface IncomingReportRow {
  /** AUR5X… — el código definitivo. */
  guide_code: string | null;
  order_name: string | null;
  customer_phone: string | null;
  /** Si el reporte trae el orderNumber de Aliclik, es el vínculo exacto. */
  external_order_number?: string | null;
}

export interface Promotion {
  shipmentId: string;
  fromCode: string;
  toCode: string;
  /** Cómo se decidió. Se registra para poder auditar los emparejamientos. */
  method: "external_order_number" | "order_id" | "order_name_phone" | "phone";
}

export interface Ambiguity {
  guideCode: string;
  reason: "varios_candidatos" | "varias_guias_para_el_pedido";
  candidateIds: string[];
}

export interface ReconcileResult {
  promotions: Promotion[];
  ambiguous: Ambiguity[];
}

/** Estados en los que ya no tiene sentido renombrar: la guía terminó su vida. */
const TERMINAL = new Set(["entregado", "anulado", "transferido"]);

/**
 * Decide qué guías creadas por API deben adoptar el código definitivo del
 * reporte.
 *
 * Orden de emparejamiento, del más fiable al más débil:
 *   1. `external_order_number` — si el reporte lo trae, es igualdad exacta y no
 *      admite discusión. (Pendiente de confirmar con Aliclik que lo exporte.)
 *   2. `order_id` — misma guía, mismo pedido ya vinculado.
 *   3. nombre de pedido + teléfono — ambos deben coincidir. Solo el nombre no
 *      basta: un pedido puede tener varias guías (reprogramaciones, Fenix).
 *   4. teléfono, y solo si hay exactamente UN candidato con ese teléfono.
 *
 * NUNCA promueve cuando hay más de un candidato, cuando la guía ya es terminal,
 * o cuando el código de destino ya lo lleva otra guía. En la duda no se toca
 * nada y la fila cae en la cola de revisión que ya existe.
 */
export function reconcileAliclikApiGuides(
  incoming: readonly IncomingReportRow[],
  apiGuides: readonly ApiCreatedGuide[],
  opts: { existingGuideCodes?: readonly string[] } = {},
): ReconcileResult {
  const promotions: Promotion[] = [];
  const ambiguous: Ambiguity[] = [];

  // Guías que ya existen con el código definitivo: si el AUR5X ya está en la
  // base, el envío ya se ingestó por Excel antes y no hay nada que promover.
  const taken = new Set(opts.existingGuideCodes ?? []);
  // Una guía solo se puede promover una vez por lote.
  const used = new Set<string>();

  const available = apiGuides.filter((g) => !TERMINAL.has(g.delivery_status));

  for (const row of incoming) {
    const target = (row.guide_code ?? "").trim();
    if (!target) continue;
    // Ya existe una guía con ese código: no es un renombrado, es un reimport.
    if (taken.has(target)) continue;

    const pool = available.filter((g) => !used.has(g.id) && g.guide_code !== target);
    if (!pool.length) continue;

    // 1. Por orderNumber, cuando el reporte lo trae.
    const ext = (row.external_order_number ?? "").trim();
    if (ext) {
      const hit = pool.filter((g) => g.external_order_number === ext);
      const only = hit.length === 1 ? hit[0] : undefined;
      if (only) {
        promotions.push({
          shipmentId: only.id,
          fromCode: only.guide_code,
          toCode: target,
          method: "external_order_number",
        });
        used.add(only.id);
        taken.add(target);
        continue;
      }
      if (hit.length > 1) {
        ambiguous.push({
          guideCode: target,
          reason: "varias_guias_para_el_pedido",
          candidateIds: hit.map((g) => g.id),
        });
        continue;
      }
    }

    const wantName = normalizeOrderName(row.order_name);
    const wantPhone = normalizePhone(row.customer_phone);

    // 2. Nombre de pedido + teléfono. Los dos, a propósito: un pedido puede
    //    tener varias guías, así que el nombre por sí solo no identifica una.
    if (wantName && wantPhone) {
      const hit = pool.filter(
        (g) =>
          normalizeOrderName(g.order_name) === wantName &&
          normalizePhone(g.customer_phone) === wantPhone,
      );
      const only = hit.length === 1 ? hit[0] : undefined;
      if (only) {
        promotions.push({
          shipmentId: only.id,
          fromCode: only.guide_code,
          toCode: target,
          method: "order_name_phone",
        });
        used.add(only.id);
        taken.add(target);
        continue;
      }
      if (hit.length > 1) {
        ambiguous.push({
          guideCode: target,
          reason: "varias_guias_para_el_pedido",
          candidateIds: hit.map((g) => g.id),
        });
        continue;
      }
    }

    // 3. Solo el teléfono, y solo si es inequívoco.
    if (wantPhone) {
      const hit = pool.filter((g) => normalizePhone(g.customer_phone) === wantPhone);
      const only = hit.length === 1 ? hit[0] : undefined;
      if (only) {
        promotions.push({
          shipmentId: only.id,
          fromCode: only.guide_code,
          toCode: target,
          method: "phone",
        });
        used.add(only.id);
        taken.add(target);
        continue;
      }
      if (hit.length > 1) {
        ambiguous.push({
          guideCode: target,
          reason: "varios_candidatos",
          candidateIds: hit.map((g) => g.id),
        });
      }
    }
  }

  return { promotions, ambiguous };
}

/**
 * ¿Este código de guía es un orderNumber provisional de Aliclik?
 *
 * Sirve para que la interfaz pueda enseñar "guía pendiente de código definitivo"
 * en vez de un ALC… que el equipo no reconocería. No colisiona con el detector
 * del importador (`/AUR5X[A-Za-z0-9]+/i`): son prefijos disjuntos.
 */
export function isProvisionalGuideCode(code: string | null | undefined): boolean {
  return /^ALC\d+/i.test((code ?? "").trim());
}

// ---------------------------------------------------------------------------
// La marca del pedido en la nota.
//
// PARA QUÉ. Cuando una creación se va en timeout, Aliclik pudo haber creado la
// guía y su número se perdió con la respuesta. El barrido tiene que reconocerla
// entre los pedidos de la ventana, y hasta ahora lo hacía POR TELÉFONO — el
// único dato estable que mandábamos y que Aliclik devuelve. Pero un teléfono no
// identifica un pedido: hoy mismo hay 7 clientes con dos o más pedidos en los
// últimos 14 días, así que la guía huérfana podía pegarse al pedido equivocado.
//
// `note` es texto libre que mandamos nosotros y que la API DEVUELVE
// (`AliclikOrder.note`). Estampando ahí el nombre del pedido, el reencuentro
// deja de ser una heurística y pasa a ser una identidad.
//
// La marca va al final y entre corchetes para que se distinga de lo que escribe
// el operador. Es visible para Aliclik: eso es deseable, porque el mismo dato
// sirve para rastrear la guía desde su panel.
// ---------------------------------------------------------------------------

const MARKER_RE = /\[Kapta (#[^\]]{1,40})\]/;

/** Añade la marca a la nota del operador. Idempotente: no la duplica. */
export function stampOrderMarker(
  note: string | null | undefined,
  orderName: string | null | undefined,
): string | undefined {
  const base = (note ?? "").trim();
  const name = (orderName ?? "").trim();
  // Sin nombre de pedido no hay nada que estampar: se devuelve la nota tal cual.
  if (!name) return base || undefined;
  if (readOrderMarker(base) === name) return base;
  const marker = `[Kapta ${name.startsWith("#") ? name : `#${name}`}]`;
  return base ? `${base} ${marker}` : marker;
}

/** Lee la marca de una nota devuelta por Aliclik. `null` si no la lleva. */
export function readOrderMarker(note: string | null | undefined): string | null {
  const found = MARKER_RE.exec((note ?? "").trim());
  return found ? found[1]!.trim() : null;
}
