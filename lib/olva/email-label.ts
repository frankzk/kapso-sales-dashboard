// El rótulo que Olva manda por correo al registrar un envío (MOM §12,
// «Cotejar Olva»): lo que dice y con qué salida casa. PURO Y TESTEADO.
//
// POR QUÉ EL CORREO Y NO EL PORTAL. El listado del portal no trae el
// documento ni el teléfono del destinatario, y el rótulo que baja el portal
// tampoco. El PDF que llega por correo («Registro exitoso … - Registro Nro
// …», de notificaciones@olva.com.pe) sí: es el rótulo del registro, con
// «RECIBE», «RUC/DNI» y «TELEFONO/CELULAR». Make lo saca del buzón y lo manda
// a /api/webhooks/olva-email.
//
// La forma, del rótulo real del 02-10-2026 (tracking 2660913-26):
//
//   OLVA LIMA   TRACKING 2660913-26   (ubigeo) 080101
//   ENVIA: GRUPO GF S.A.C.   RUC/DNI: 20556792829   TELEFONO/CELULAR: 965391481
//   RECIBE: WALTER DAVID …   RUC/DNI: 09949462      TELEFONO/CELULAR: 942543603
//   DIRECCION: CUSCO - AV PARDO …   REFERENCIA: OFICINA TIENDA …
//   N° REGISTRO: 202600715289 (1/1)   FECHA WEB: 02/10/26
//
// El texto que sale de un PDF no garantiza saltos de línea ni orden de
// columnas, así que se lee como una sola tira y se parte por los rótulos.

import { parseOlvaTracking, type OlvaTrackingId } from "@/lib/olva/tracking";
import { createdNear, sharedNames, type CotejoCandidate } from "@/lib/olva/portal-match";

export interface OlvaEmailLabel {
  id: OlvaTrackingId | null;
  senderDoc: string | null;
  recipientName: string | null;
  recipientDoc: string | null;
  recipientPhone: string | null;
  address: string | null;
  reference: string | null;
  registro: string | null;
  ubigeo: string | null;
  /** YYYY-MM-DD de «FECHA WEB», si se pudo leer. */
  fecha: string | null;
}

const LABELS = "ENVIA|RECIBE|RUC\\/DNI|TELEFONO\\/CELULAR|DIRECCI[OÓ]N|REFERENCIA|N[°ºo]?\\s*REGISTRO|FECHA WEB|TRACKING";

function until(text: string, label: string): string | null {
  const m = text.match(new RegExp(`(?:${label})\\s*:\\s*(.*?)(?=\\s+(?:${LABELS})\\b|$)`, "i"));
  const v = m?.[1]?.trim();
  return v ? v : null;
}

/** Los dígitos del teléfono peruano, sin el 51 delante: «942543603». */
export function phoneKey(raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  return d.length >= 9 ? d.slice(-9) : null;
}

export function parseOlvaLabelText(raw: string): OlvaEmailLabel {
  const text = raw.replace(/\s+/g, " ").trim();

  // «TRACKING 2660913-26» en el rótulo del correo; «0-26-02649804» en el que
  // baja el portal (ese «0-» delante no es parte del número).
  const t = text.match(/TRACKING\s*:?\s*(\d[\d\s/-]{3,22}\d)/i)?.[1]?.replace(/\s+/g, "").replace(/^0-(?=\d{2}-)/, "");
  const parsed = t ? parseOlvaTracking(t) : null;

  const cut = text.search(/RECIBE\s*:/i);
  const sender = cut >= 0 ? text.slice(0, cut) : "";
  const recipient = cut >= 0 ? text.slice(cut) : "";

  const doc = (part: string) => part.match(/RUC\/DNI\s*:\s*(\d{8,11})/i)?.[1] ?? null;
  const phone = recipient.match(/TELEFONO\/CELULAR\s*:\s*\+?(\d[\d ]{6,16}\d)/i)?.[1]?.replace(/\s/g, "") ?? null;
  const web = text.match(/FECHA WEB\s*:\s*(\d{2})\/(\d{2})\/(\d{2,4})/i);
  const year = web?.[3] ? (web[3].length === 2 ? `20${web[3]}` : web[3]) : null;

  return {
    id: parsed?.ok ? parsed.value : null,
    senderDoc: doc(sender),
    recipientName: recipient ? until(recipient, "RECIBE") : null,
    recipientDoc: doc(recipient),
    recipientPhone: phone,
    address: until(recipient, "DIRECCI[OÓ]N"),
    reference: until(recipient, "REFERENCIA")?.replace(/\s*N[°ºo]?\s*$/i, "") ?? null,
    registro: text.match(/REGISTRO\s*:?\s*(\d{6,})/i)?.[1] ?? null,
    ubigeo: text.match(/\(ubigeo\)\s*(\d{6})/i)?.[1] ?? null,
    fecha: web && year ? `${year}-${web[2]}-${web[1]}` : null,
  };
}

export type LabelMatch =
  | { kind: "match"; candidate: CotejoCandidate; via: "telefono" | "dni" }
  | { kind: "ambiguous"; candidates: CotejoCandidate[] }
  | { kind: "none" };

/**
 * ¿Qué salida de Olva sin tracking es la de este rótulo? Vale si es UNA sola,
 * con el mismo teléfono o el mismo DNI, al menos un nombre en común y creada
 * en la ventana de fechas. Con dos —la misma clienta con dos pedidos— no se
 * adivina.
 */
export function matchLabel(label: OlvaEmailLabel, candidates: CotejoCandidate[]): LabelMatch {
  if (!label.recipientName) return { kind: "none" };
  const phone = phoneKey(label.recipientPhone);
  const doc = label.recipientDoc;
  const hits: { candidate: CotejoCandidate; via: "telefono" | "dni" }[] = [];
  for (const c of candidates) {
    if (!createdNear(c, label.fecha)) continue;
    if (sharedNames(c.customerName, label.recipientName) < 1) continue;
    if (phone && phoneKey(c.phone) === phone) hits.push({ candidate: c, via: "telefono" });
    else if (doc && c.dni === doc) hits.push({ candidate: c, via: "dni" });
  }
  const [only] = hits;
  if (hits.length === 1 && only) return { kind: "match", ...only };
  if (hits.length > 1) return { kind: "ambiguous", candidates: hits.map((h) => h.candidate) };
  return { kind: "none" };
}
