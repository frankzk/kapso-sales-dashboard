// Novedades de Swayp (estado 6): el mensajero llegó, no pudo entregar, y la
// guía queda esperando una instrucción. Este módulo arma esa instrucción, o
// explica por qué no se puede mandar. Puro y testeado.
//
// POR QUÉ VALIDAMOS ACÁ Y NO NOS APOYAMOS EN LA API. Probado contra el entorno
// de pruebas: `setNoveltySolution` resuelve la guía ANTES de mirar el payload
// —una acción inválida o un comentario ausente devuelven igual
// `404 No se encontró la guía` si el número no existe—. O sea que la API no nos
// va a corregir un payload mal armado sobre una guía que sí existe: lo va a
// aceptar o a fallar de una forma que no distingue el motivo. La validación de
// acá es la única red entre la operadora y una instrucción equivocada sobre un
// paquete real.

import { limaTodayKey } from "@/lib/shipments";
import type { SwaypNoveltySolution } from "@/lib/swayp";

/** Las tres respuestas que Swayp acepta para una novedad de tipo Gestión. */
export const NOVELTY_ACTIONS = {
  "1": {
    label: "Volver a ofrecer",
    /** Lo que va a pasar, en el idioma de la operadora. */
    hint: "El mensajero intenta la entrega otra vez, sin cambiar la fecha.",
    needsDate: false,
    /** Termina el intento y manda el paquete de vuelta: pide `closure.return`. */
    isReturn: false,
  },
  "2": {
    label: "Devolver al remitente",
    hint: "Se cierra el intento y el paquete vuelve a la bodega. No se deshace.",
    needsDate: false,
    isReturn: true,
  },
  "3": {
    label: "Reprogramar la entrega",
    hint: "El mensajero vuelve otro día, con la fecha que elijas.",
    needsDate: true,
    isReturn: false,
  },
} as const satisfies Record<
  SwaypNoveltySolution["accion"],
  { label: string; hint: string; needsDate: boolean; isReturn: boolean }
>;

export type NoveltyAction = keyof typeof NOVELTY_ACTIONS;

export function isNoveltyAction(value: unknown): value is NoveltyAction {
  return value === "1" || value === "2" || value === "3";
}

/** ¿Esta acción cierra la entrega y dispara la devolución física? */
export function noveltyActionIsReturn(action: NoveltyAction): boolean {
  return NOVELTY_ACTIONS[action].isReturn;
}

export interface BuildNoveltyInput {
  /** Número de guía que emitió Swayp (`shipments.swayp_guide`). */
  guia: string | null | undefined;
  accion: string | null | undefined;
  comentario: string | null | undefined;
  /** Sólo para la acción 3. `YYYY-MM-DD` o ISO 8601 completo. */
  fechaEntregaIso?: string | null;
  /** Inyectable para las pruebas. */
  now?: Date;
}

export type BuildNoveltyResult =
  | { ok: true; input: SwaypNoveltySolution }
  | { ok: false; error: string };

/**
 * Arma la solución de la novedad, o explica por qué no se puede mandar.
 *
 * La fecha se exige desde MAÑANA, no desde hoy, por la misma razón que la
 * creación de guía: Swayp arma sus rutas entre las 16:00 y las 17:00 para el día
 * siguiente (MOM §9), así que reprogramar «para hoy» es pedir algo que ya no
 * entra en ninguna ruta.
 */
export function buildNoveltySolution(b: BuildNoveltyInput): BuildNoveltyResult {
  const guia = (b.guia ?? "").trim();
  if (!guia) {
    return { ok: false, error: "Este envío no tiene guía de Swayp, así que no hay novedad que resolver." };
  }

  if (!isNoveltyAction(b.accion)) {
    return { ok: false, error: "Elige qué hacer con la novedad." };
  }
  const accion = b.accion;

  // Swayp se lo muestra al mensajero: un comentario vacío lo deja sin saber qué
  // se decidió y por qué.
  const comentario = (b.comentario ?? "").trim();
  if (!comentario) {
    return { ok: false, error: "Escribe un comentario: el mensajero lo lee para saber qué hacer." };
  }

  if (!NOVELTY_ACTIONS[accion].needsDate) {
    // La documentación dice que `fechaEntrega` se ignora en las acciones 1 y 2.
    // No la mandamos en vez de confiar en que la ignoren.
    return { ok: true, input: { guia, accion, comentario } };
  }

  const raw = (b.fechaEntregaIso ?? "").trim();
  if (!raw) return { ok: false, error: "Elige la nueva fecha de entrega." };

  const day = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(raw))) {
    return { ok: false, error: "La nueva fecha de entrega no es válida." };
  }
  if (day <= limaTodayKey(b.now ?? new Date())) {
    return { ok: false, error: "La nueva fecha de entrega tiene que ser desde mañana." };
  }

  return { ok: true, input: { guia, accion, comentario, fechaEntrega: raw } };
}
