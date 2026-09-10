// Sacar la constancia de PAGO de la respuesta de evidencias de Tanders.
//
// EL CASO. Del 15-08 al 10-09-2026 el barrido de cobros no validó ni una guía:
// las 60 salían «sin constancia aún». La respuesta cruda enseñó por qué — el
// enlace vive en `payments[].paymentDocument`, y esa clave no estaba en la
// lista que mira `firstUrl`. El extractor se había escrito contra una forma
// IMAGINADA y no tenía ni una prueba, así que fallaba en silencio: como falla
// cerrada, «no la encuentro» y «no la hay todavía» daban lo mismo por fuera.
//
// De ahí este archivo: la primera prueba es la respuesta LITERAL de una guía
// entregada. Lo demás son las trampas que la hacen peligrosa si se relaja.

import { describe, expect, it } from "vitest";
import { extractPaymentEvidence } from "@/lib/tanders/client";

/** Respuesta real de `GET /orders/me/{id}/aliclik/evidences` (10-09-2026). */
const RESPUESTA_REAL = {
  orderNumber: "TANDER17888213584909995",
  evidences: [
    {
      id: 2379859,
      deliveryStatus: "DELIVERED",
      subStatus: null,
      comment: "-conforme ",
      evidenceDelivery: null,
      evidenceSupport: null,
      evidenceCall: null,
      evidenceChat: null,
      evidenceCallChat: null,
      method: "Asignación masiva por mapa",
      deliveryDate: "2026-09-08T05:00:00.000Z",
      createdAt: "2026-09-08T12:28:43.094Z",
    },
  ],
  payments: [
    {
      id: "9012005020726781",
      amount: 298,
      paymentMethod: "T",
      entity: "YAPE",
      paymentDate: "2026-09-08T00:00:00.000Z",
      paymentDocument:
        "https://firebasestorage.googleapis.com/v0/b/wanklik-platform.appspot.com/o/files_payment%2FTANDER17888213584909995%2F1788894720579-75fd20ba-20260908_141152.jpg?alt=media&token=ad50889e",
      status: "VERIFIED",
      orderDeliveryId: null,
      createdAt: "2026-09-08T19:12:12.018Z",
    },
  ],
};

describe("extractPaymentEvidence", () => {
  it("encuentra la constancia en la respuesta real de una guía entregada", () => {
    const [pago, ...resto] = extractPaymentEvidence(RESPUESTA_REAL);
    expect(resto).toHaveLength(0);
    expect(pago?.imageUrl).toContain("files_payment");
    expect(pago?.amount).toBe(298);
    expect(pago?.status).toBe("VERIFIED");
  });

  it("el medio es `entity`, no el `method` de la entrega", () => {
    // «Asignación masiva por mapa» es CÓMO se repartió el paquete. Colarlo
    // como medio de pago metería esa frase en el veredicto de un cobro.
    const [pago] = extractPaymentEvidence(RESPUESTA_REAL);
    expect(pago?.method).toBe("YAPE");
  });

  it("no confunde la foto de la entrega con la constancia de pago", () => {
    // La entrega se sube a otra carpeta. Si esto se colara, la foto de un
    // paquete pasaría por el lector de comprobantes y decidiría un cobro.
    const conFotoDeEntrega = {
      ...RESPUESTA_REAL,
      evidences: [
        {
          ...RESPUESTA_REAL.evidences[0],
          evidenceDelivery:
            "https://firebasestorage.googleapis.com/v0/b/wanklik-platform.appspot.com/o/files_delivery%2FTANDER17888213584909995%2Fpaquete.jpg?alt=media",
        },
      ],
    };
    const pagos = extractPaymentEvidence(conFotoDeEntrega);
    expect(pagos).toHaveLength(1);
    expect(pagos[0]?.imageUrl).toContain("files_payment");
  });

  it("una guía entregada sin cobro todavía no devuelve nada", () => {
    const sinPago = { ...RESPUESTA_REAL, payments: [] };
    expect(extractPaymentEvidence(sinPago)).toEqual([]);
  });

  it("devuelve todas cuando hubo más de un intento de cobro", () => {
    // El barrido se queda con la ÚLTIMA; esta función tiene que darlas todas
    // y en orden, o «la última» sería la equivocada.
    const dos = {
      ...RESPUESTA_REAL,
      payments: [
        { ...RESPUESTA_REAL.payments[0], amount: 100, paymentDocument: urlPago("primera") },
        { ...RESPUESTA_REAL.payments[0], amount: 298, paymentDocument: urlPago("segunda") },
      ],
    };
    const pagos = extractPaymentEvidence(dos);
    expect(pagos.map((p) => p.amount)).toEqual([100, 298]);
  });

  it("aguanta que su API cambie de forma sin inventarse una constancia", () => {
    // Si Tanders renombra la clave, esto tiene que salir vacío: el barrido lo
    // deja PENDIENTE, que bloquea el cobro sin acusar a nadie.
    expect(extractPaymentEvidence(null)).toEqual([]);
    expect(extractPaymentEvidence({})).toEqual([]);
    expect(extractPaymentEvidence({ payments: [{ amount: 298, entity: "YAPE" }] })).toEqual([]);
  });
});

function urlPago(nombre: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/wanklik-platform.appspot.com/o/files_payment%2FTANDER1%2F${nombre}.jpg?alt=media`;
}
