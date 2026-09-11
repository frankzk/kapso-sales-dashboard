import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  MAX_CANDIDATOS,
  VENTANA_CANDIDATOS_MS,
  debeGuardarTelefono,
  etiquetaCandidato,
  nombreApunta,
  ordenarCandidatos,
  type CandidatoSinNumero,
} from "@/lib/lead-sin-numero";

const cand = (over: Partial<CandidatoSinNumero> & { id: string }): CandidatoSinNumero => ({
  name: null,
  username: null,
  adHeadline: null,
  lastInteractionAt: "2026-09-11T16:00:00.000Z",
  ...over,
});

describe("guardar el celular tecleado en el lead", () => {
  // El hueco es lo que rompe tres cosas a la vez: el courier no tiene a quién
  // llamar, «Venta telefónica» no encuentra al cliente y crea un clon sin
  // `ad_id`, y la próxima vez vuelve a pasar.
  it("se rellena cuando el lead no traía número", () => {
    expect(debeGuardarTelefono(null, "51921308090")).toBe(true);
    expect(debeGuardarTelefono(undefined, "51921308090")).toBe(true);
    expect(debeGuardarTelefono("", "51921308090")).toBe(true);
  });

  // El del lead vino de WhatsApp y ES la identidad del cliente; el del
  // formulario puede ser el de quien recibe el paquete. Coinciden en 4.461 de
  // 4.465 pedidos (99,9%), así que rellenar es seguro — pisar no aporta nada y
  // puede meter a dos personas en una sola ficha.
  it("NUNCA se pisa un número que el lead ya tenía", () => {
    expect(debeGuardarTelefono("51900000001", "51921308090")).toBe(false);
    expect(debeGuardarTelefono("51900000001", null)).toBe(false);
  });

  it("sin número tecleado no se escribe nada", () => {
    expect(debeGuardarTelefono(null, null)).toBe(false);
    expect(debeGuardarTelefono(null, undefined)).toBe(false);
    expect(debeGuardarTelefono(null, "")).toBe(false);
    expect(debeGuardarTelefono(null, "   ")).toBe(false);
  });
});

describe("a quién se ofrece cuando el número no existe", () => {
  it("el nombre tecleado señala por palabras, no por igualdad", () => {
    const claudia = cand({ id: "c", name: "Claudia Nycole Arismendi " });
    // El caso real: la asesora escribe el nombre de pila, la ficha trae el
    // completo. Exigir la cadena entera dejaría fuera justo esto.
    expect(nombreApunta("Claudia", claudia)).toBe(true);
    expect(nombreApunta("claudia nycole", claudia)).toBe(true);
    expect(nombreApunta("Arismendi", claudia)).toBe(true);
    expect(nombreApunta("Rosa", claudia)).toBe(false);
  });

  it("también por el nombre de usuario, que es lo que se vio en el chat", () => {
    expect(nombreApunta("ClauNicky234", cand({ id: "c", username: "ClauNicky234" }))).toBe(true);
    expect(nombreApunta("claunicky", cand({ id: "c", username: "ClauNicky234" }))).toBe(true);
  });

  it("ignora acentos y mayúsculas", () => {
    expect(nombreApunta("JOSE", cand({ id: "c", name: "José Dávila" }))).toBe(true);
    expect(nombreApunta("davila", cand({ id: "c", name: "José Dávila" }))).toBe(true);
  });

  // Una inicial suelta coincide con media cola y convertiría el aviso en ruido.
  it("una letra suelta no señala a nadie", () => {
    expect(nombreApunta("C", cand({ id: "c", name: "Claudia" }))).toBe(false);
    expect(nombreApunta("", cand({ id: "c", name: "Claudia" }))).toBe(false);
    expect(nombreApunta(null, cand({ id: "c", name: "Claudia" }))).toBe(false);
    expect(nombreApunta("a b c", cand({ id: "c", name: "Claudia" }))).toBe(false);
  });

  it("una ficha sin nombre ni usuario no la señala nada", () => {
    expect(nombreApunta("Claudia", cand({ id: "c" }))).toBe(false);
  });

  // EL NOMBRE ORDENA, NO FILTRA: es opcional en el formulario y muchas fichas
  // llegan con el apodo de WhatsApp («andreita😘») en vez del nombre real, así
  // que descartar por no coincidir escondería al cliente que se busca.
  it("el que coincide va primero, pero los demás NO se descartan", () => {
    const out = ordenarCandidatos(
      [
        cand({ id: "reciente", name: "Otra", lastInteractionAt: "2026-09-11T17:00:00.000Z" }),
        cand({ id: "claudia", name: "Claudia Nycole", lastInteractionAt: "2026-09-11T16:00:00.000Z" }),
      ],
      "Claudia",
    );
    expect(out.map((c) => c.id)).toEqual(["claudia", "reciente"]);
  });

  it("sin nombre tecleado manda lo más reciente", () => {
    const out = ordenarCandidatos(
      [
        cand({ id: "viejo", lastInteractionAt: "2026-09-11T10:00:00.000Z" }),
        cand({ id: "nuevo", lastInteractionAt: "2026-09-11T17:00:00.000Z" }),
        cand({ id: "medio", lastInteractionAt: "2026-09-11T14:00:00.000Z" }),
      ],
      null,
    );
    expect(out.map((c) => c.id)).toEqual(["nuevo", "medio", "viejo"]);
  });

  it("una fecha ilegible cae al final en vez de romper el orden", () => {
    const out = ordenarCandidatos(
      [cand({ id: "roto", lastInteractionAt: "no-es-fecha" }), cand({ id: "bueno" })],
      null,
    );
    expect(out.map((c) => c.id)).toEqual(["bueno", "roto"]);
  });

  // Medido sobre 7 días de Kenku en ventanas de dos horas: 3 candidatos de
  // media y 16 en el peor caso. Una lista de 16 tapa el formulario.
  it("la lista se corta para que quepa en pantalla", () => {
    const muchos = Array.from({ length: 16 }, (_, i) =>
      cand({ id: `c${i}`, lastInteractionAt: `2026-09-11T${String(i).padStart(2, "0")}:00:00.000Z` }),
    );
    expect(ordenarCandidatos(muchos, null)).toHaveLength(MAX_CANDIDATOS);
  });

  it("no revienta con la lista vacía", () => {
    expect(ordenarCandidatos([], "Claudia")).toEqual([]);
  });

  // La ventana cubre el caso real —Claudia escribió a las 11:22 y se le vendió a
  // las 11:29— sin arrastrar conversaciones de ayer.
  it("la ventana son dos horas", () => {
    expect(VENTANA_CANDIDATOS_MS).toBe(2 * 60 * 60_000);
  });
});

describe("cómo se nombra al candidato en la lista", () => {
  // El usuario va siempre que exista: es lo único que la asesora acaba de ver en
  // el chat, y muchas fichas traen de nombre un apodo con emoji.
  it("nombre y usuario juntos cuando hay los dos", () => {
    expect(etiquetaCandidato(cand({ id: "c", name: "Claudia Nycole", username: "ClauNicky234" })))
      .toBe("Claudia Nycole · @ClauNicky234");
  });

  it("con uno solo, ese", () => {
    expect(etiquetaCandidato(cand({ id: "c", name: "Claudia" }))).toBe("Claudia");
    expect(etiquetaCandidato(cand({ id: "c", username: "ClauNicky234" }))).toBe("@ClauNicky234");
  });

  it("sin ninguno, algo legible y no una línea vacía", () => {
    expect(etiquetaCandidato(cand({ id: "c" }))).toBe("Sin nombre");
    expect(etiquetaCandidato(cand({ id: "c", name: "  ", username: "  " }))).toBe("Sin nombre");
  });
});

// La regla puede estar bien pensada y no llegar a ninguna parte. Estas guardas
// leen el fuente para probar que se aplica donde tiene que aplicarse.
describe("el arreglo llega al código que corre", () => {
  const actions = readFileSync(new URL("../app/dashboard/leads/actions.ts", import.meta.url), "utf8");
  const venta = readFileSync(
    new URL("../app/dashboard/leads/venta-telefonica-actions.ts", import.meta.url),
    "utf8",
  );
  const ui = readFileSync(new URL("../components/venta-telefonica.tsx", import.meta.url), "utf8");

  it("generar el pedido guarda el celular en el lead", () => {
    expect(actions).toContain("debeGuardarTelefono(l.phone, phone)");
    expect(actions).toContain("{ ...leadPatch, phone }");
  });

  // `leads` tiene índice único en (store_id, phone). Si un duplicado anterior ya
  // se quedó con ese número, el update ENTERO fallaría y el lead se quedaría sin
  // `order_id` ni acreditación — peor que el hueco que se venía a tapar.
  it("un choque con el índice único no puede tumbar la venta", () => {
    const bloque = actions.slice(
      actions.indexOf("const leadUpdate = (async () => {"),
      actions.indexOf("const draftMirror"),
    );
    expect(bloque).toContain('error.code !== "23505"');
    expect(bloque).toContain("await admin.from(\"leads\").update(leadPatch).eq(\"id\", leadId);");
  });

  it("la venta telefónica ofrece las conversaciones sin número antes de crear otra", () => {
    expect(venta).toContain("conversacionesSinNumero(storeId, nombre)");
    expect(venta).toContain('.is("phone", null)');
    // Y solo cuando NO se encontró al cliente: si apareció, no hay nada que
    // desambiguar y la lista sería ruido.
    expect(venta).toContain("const candidatos = l ? [] : await conversacionesSinNumero");
  });

  it("la pantalla las muestra y deja abrir la correcta", () => {
    expect(ui).toContain("ordenarCandidatos(res.candidatos ?? [], nombre)");
    expect(ui).toContain("onAbrir(c.id)");
    expect(ui).toContain("etiquetaCandidato(c)");
    // Y pasa el nombre a la consulta, o el orden por nombre no serviría de nada.
    expect(ui).toContain("consultarClientePorTelefono(storeId, phone, nombre)");
  });
});
