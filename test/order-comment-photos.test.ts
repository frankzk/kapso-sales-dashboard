import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ORDER_COMMENT_MAX_PHOTOS,
  ORDER_COMMENT_TYPE_SUGGESTIONS,
  imageFilesFrom,
  isOrderCommentPhotoPath,
  orderCommentPhotoExt,
  orderCommentPhotoUrl,
  orderCommentPhotosFromPayload,
  validateOrderCommentPhotos,
} from "@/lib/order-comment-photos";
import { orderEventsToTimeline } from "@/lib/orders-master-access";
import type { OrderEventRow } from "@/lib/types";

const STORE = "store-1";
const ORDER = "order-1";
const ok = (n: number) => `${STORE}/${ORDER}/comment-${1700000000000 + n}-abcd1234.jpg`;

describe("fotos de constancia del comentario (MOM §43)", () => {
  it("acepta solo rutas de ESE pedido", () => {
    expect(isOrderCommentPhotoPath(ok(1), STORE, ORDER)).toBe(true);
    expect(isOrderCommentPhotoPath(`${STORE}/otro/comment-1.jpg`, STORE, ORDER)).toBe(false);
    expect(isOrderCommentPhotoPath(`otra/${ORDER}/comment-1.jpg`, STORE, ORDER)).toBe(false);
    expect(isOrderCommentPhotoPath(`${STORE}/${ORDER}/manual-1.jpg`, STORE, ORDER)).toBe(false);
    expect(isOrderCommentPhotoPath(`${STORE}/${ORDER}/comment-../x.jpg`, STORE, ORDER)).toBe(false);
    expect(isOrderCommentPhotoPath(`${STORE}/${ORDER}/comment-a/b.jpg`, STORE, ORDER)).toBe(false);
  });

  it("limpia, no repite y respeta el tope de 4", () => {
    expect(validateOrderCommentPhotos(null, STORE, ORDER)).toEqual({ paths: [] });
    expect(validateOrderCommentPhotos([ok(1), ok(1), ` ${ok(2)} `], STORE, ORDER)).toEqual({ paths: [ok(1), ok(2)] });
    const many = Array.from({ length: ORDER_COMMENT_MAX_PHOTOS + 1 }, (_, i) => ok(i));
    expect(validateOrderCommentPhotos(many, STORE, ORDER)).toEqual({ error: "Máximo 4 fotos por comentario." });
    expect(validateOrderCommentPhotos([ok(1), "x/y/comment-1.jpg"], STORE, ORDER)).toEqual({
      error: "Una de las fotos no pertenece a este pedido.",
    });
  });

  it("solo imágenes que el navegador pinta", () => {
    expect(orderCommentPhotoExt("image/jpeg")).toBe("jpg");
    expect(orderCommentPhotoExt("IMAGE/PNG")).toBe("png");
    expect(orderCommentPhotoExt("image/webp")).toBe("webp");
    expect(orderCommentPhotoExt("image/heic")).toBeNull();
    expect(orderCommentPhotoExt("application/pdf")).toBeNull();
    const files = [
      new File(["a"], "a.png", { type: "image/png" }),
      new File(["b"], "b.pdf", { type: "application/pdf" }),
      new File(["c"], "c.heic", { type: "image/heic" }),
    ];
    expect(imageFilesFrom(files).map((f) => f.name)).toEqual(["a.png"]);
  });

  it("lee las fotos del hecho y arma la URL", () => {
    expect(orderCommentPhotosFromPayload({ photos: [ok(1), 3, "", ok(2)] })).toEqual([ok(1), ok(2)]);
    expect(orderCommentPhotosFromPayload({})).toEqual([]);
    expect(orderCommentPhotosFromPayload(null)).toEqual([]);
    expect(orderCommentPhotoUrl(ORDER, ok(1))).toBe(
      `/api/pedidos/${ORDER}/comentario-foto?path=${encodeURIComponent(ok(1))}`,
    );
  });

  it("la Actividad lleva el tipo y las fotos del comentario, y nada en otros hechos", () => {
    const base: OrderEventRow = {
      id: "1",
      store_id: STORE,
      order_id: ORDER,
      kind: "comment",
      occurred_at: "2026-11-10T15:00:00Z",
      actor: "u-gero",
      source: "manual",
      courier: null,
      guide_code: null,
      previous_status: null,
      new_status: null,
      previous_operational: null,
      new_operational: null,
      attempt_number: null,
      reason: null,
      note: "Lo llamé, no contestó; le dejé WhatsApp pidiendo la diferencia.",
      comment_type: "Pago de diferencia",
      shipment_id: null,
      batch_id: null,
      payload: { photos: [ok(1)] },
    };
    const [comment, status] = orderEventsToTimeline(
      [base, { ...base, id: "2", kind: "status_changed", comment_type: null, payload: {} }],
      new Map([["u-gero", "Gero"]]),
    );
    expect(comment).toMatchObject({ actorName: "Gero", commentType: "Pago de diferencia", photos: [ok(1)] });
    expect(status).not.toHaveProperty("photos");
    expect(status).not.toHaveProperty("commentType");
  });

  it("sugiere el tipo «Pago de diferencia»", () => {
    expect(ORDER_COMMENT_TYPE_SUGGESTIONS).toContain("Pago de diferencia");
  });

  it("la tarjeta Comentario escucha el pegado en ella, no en la ventana", () => {
    const ui = readFileSync("components/order-comment-photos.tsx", "utf8");
    expect(ui).not.toMatch(/addEventListener\("paste"/);
    const drawer = readFileSync("components/order-drawer.tsx", "utf8");
    expect(drawer).toMatch(/onPaste=\{\(e\) => \{\s*const images = commentPastedImages\(e\)/);
  });

  it("el MOM documenta la regla", () => {
    const mom = readFileSync("docs/mom/master-pedidos-v1.md", "utf8");
    expect(mom).toContain("## 43. Fotos de constancia en el comentario del pedido");
    expect(mom).toContain("order_events.payload.photos");
  });
});
