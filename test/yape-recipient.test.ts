import { describe, expect, it } from "vitest";
import {
  verifyYapeRecipient as verifyAgainstAccounts,
  yapeRecipientReadingFromVision as readingAgainstAccounts,
  type CollectionAccount,
  readingLooksSwapped,
  type YapeRecipientCheck,
} from "@/lib/yape-recipient";

/** Las cuentas de cobro reales del negocio (semilla de la migración 0126). */
const CUENTAS: CollectionAccount[] = [
  { name: "Grupo GF S.A.C.", phoneLastDigits: "309" },
  { name: "Gabriela Reaño Vera", phoneLastDigits: "147" },
  {
    name: "Frankz Alberto Paolo Kastner Cam",
    // La constancia del banco escribe los apellidos primero.
    aliases: ["Kastner Cam Frankz Alberto Paolo"],
    phoneLastDigits: "481",
  },
];

/** La mayoría de las pruebas hablan de la cuenta de la empresa. */
const verifyYapeRecipient = (
  name: string | null | undefined,
  phone: string | null | undefined,
  accounts: CollectionAccount[] = CUENTAS,
) => verifyAgainstAccounts(name, phone, accounts);

const yapeRecipientReadingFromVision = (
  vision: unknown,
  accounts: CollectionAccount[] = CUENTAS,
) => readingAgainstAccounts(vision, accounts);

describe("verificación de la cuenta receptora Yape", () => {
  it("verifica Grupo GF S.A.C. con el celular completo", () => {
    expect(verifyYapeRecipient("GRUPO GF S.A.C.", "930 555 309")).toMatchObject({
      status: "verified",
      nameMatches: true,
      phoneMatches: true,
    });
  });

  it("acepta una lectura segura de los últimos tres dígitos", () => {
    expect(verifyYapeRecipient("Grupo GF SAC", "***309").status).toBe("verified");
  });

  it("distingue señal parcial de una cuenta distinta", () => {
    expect(verifyYapeRecipient("Grupo GF SAC", null).status).toBe("partial");
    expect(verifyYapeRecipient(null, "309").status).toBe("partial");
    expect(verifyYapeRecipient("Otro negocio", "309").status).toBe("mismatch");
    expect(verifyYapeRecipient("Grupo GF SAC", "123").status).toBe("mismatch");
  });

  it("recalcula el estado desde la auditoría y no confía en una marca guardada", () => {
    expect(
      yapeRecipientReadingFromVision({
        extracted: {
          recipient_name: "Otro negocio",
          recipient_phone_last_digits: "309",
          recipient_check: "verified",
        },
      }),
    ).toEqual({
      name: "Otro negocio",
      phoneLastDigits: "309",
      status: "mismatch",
      account: null,
      swapped: false,
    });
  });
});

describe("el nombre que el voucher corta no es un receptor distinto", () => {
  // Los nombres reales que estaban parados en revisión administrativa: Yape y
  // la app de BCP truncan el destinatario por ancho de pantalla, y exigir el
  // sufijo S.A.C. los acusaba de desvío de dinero.
  it("acepta como lectura corta las variantes vistas en producción", () => {
    for (const leido of ["Grupo Gf S", "Grupo gf s", "Grupo Gf S.", "Grupo GF", "Grupo G***"]) {
      const v = verifyYapeRecipient(leido, null);
      expect({ leido, status: v.status, cut: v.nameCutShort }).toEqual({
        leido,
        status: "partial",
        cut: true,
      });
    }
  });

  it("una lectura corta NO verifica la cuenta, solo deja de acusarla", () => {
    // Que empiece igual no prueba nada; el operador tiene que mirar la imagen.
    expect(verifyYapeRecipient("Grupo Gf S", null).nameMatches).toBe(false);
    expect(verifyYapeRecipient("Grupo Gf S", "309").status).toBe("partial");
  });

  it("el nombre completo sigue verificando como antes", () => {
    for (const leido of ["Grupo Gf S.a.c.", "GRUPO GF S A C", "Grupo GF S.A.C."]) {
      expect(verifyYapeRecipient(leido, "309")).toMatchObject({
        status: "verified",
        nameMatches: true,
        nameCutShort: false,
      });
    }
  });

  it("un receptor de verdad distinto sigue siendo mismatch", () => {
    // Estos también estaban en los datos, y son los que la alarma existe para
    // cazar. Si el recorte los tapara, el arreglo habría salido caro.
    for (const leido of [
      "WAYKI - ADOLFO MIGUEL ERNESTO EGUILUZ OCHOA",
      "Elizabeth Sua*",
      "BCP",
      "Grupo Rodriguez",
      "Gf S.a.c.",
    ]) {
      expect({ leido, status: verifyYapeRecipient(leido, null).status }).toEqual({
        leido,
        status: "mismatch",
      });
    }
  });

  it("una sola palabra no basta para llamarlo lectura corta", () => {
    // "Grupo" a secas no distingue Grupo GF de Grupo cualquier-otra-cosa.
    expect(verifyYapeRecipient("Grupo", null).status).toBe("mismatch");
    expect(verifyYapeRecipient("G", null).status).toBe("mismatch");
  });

  it("el celular leído sigue siendo tajante, aunque el nombre venga cortado", () => {
    // La lectura corta perdona el nombre, no la otra señal: 123 no es 309.
    expect(verifyYapeRecipient("Grupo Gf S", "123").status).toBe("mismatch");
  });

  it("el recorte se lee desde el principio y en orden, no a trozos", () => {
    // Un recorte conserva el comienzo. Nada de esto lo es.
    //
    // El orden SÍ decide, y se mantuvo a propósito: la constancia del banco
    // escribe los apellidos primero («KASTNER CAM FRANKZ ALBERTO PAOLO») donde
    // Yape los pone al final, pero eso se resuelve declarando la otra forma en
    // los `aliases` de la cuenta —explícito, y lo decide una persona—. Enseñarle
    // a la comparación a ignorar el orden la volvía permisiva con todo el mundo.
    expect(verifyYapeRecipient("Gf Grupo", null).status).toBe("mismatch");
    expect(verifyYapeRecipient("Grupo Gf S A X Y", null).status).toBe("mismatch");
    expect(verifyYapeRecipient("Grupo Rf S", null).status).toBe("mismatch");
  });

  it("KP127475: el caso que lo destapó queda en partial, no en «receptor distinto»", () => {
    expect(
      yapeRecipientReadingFromVision({
        extracted: { recipient_name: "Grupo Gf S", recipient_phone_last_digits: null },
      }),
    ).toEqual({
      name: "Grupo Gf S",
      phoneLastDigits: null,
      status: "partial",
      account: CUENTAS[0],
      swapped: false,
    });
  });
});

describe("el corpus real de producción", () => {
  // Estas son lecturas TEXTUALES de `order_payments.vision`, no inventadas. Se
  // congelan aquí porque cada renglón costó una consulta a producción y porque
  // la regla que las decide es la que dice si el dinero se desvió: si alguien la
  // toca, tiene que ver exactamente a qué comprobante le cambia la respuesta.
  const corpus: [string | null, string | null, YapeRecipientCheck, string][] = [
    // — la cuenta de la empresa, entera, recortada o enmascarada —
    ["GRUPO GF S.A.C.", "309", "verified", "lectura completa"],
    ["Grupo Gf S.a.c.", "309", "verified", "con puntos"],
    ["GRUPO GF S A C", "309", "verified", "separada por espacios"],
    ["Grupo GF SAC", "309", "verified", "SAC pegado: la lectura más común"],
    ["Grupo Gf S", "309", "partial", "recortada por ancho de pantalla"],
    ["Grupo Gf S", null, "partial", "recortada y sin celular"],
    ["GRUPO GF S.A.C.", null, "partial", "completa pero sin celular"],
    ["Gr*** Gf*** S*** A*** C***", "309", "partial", "enmascarada entera"],
    ["Grupo G***", "309", "partial", "enmascarada corta"],
    ["Grupo Gf S.", null, "partial", "recortada con punto"],

    // — las cuentas de las personas dueñas (migración 0126) —
    ["Gabriela Reaño Vera", "147", "verified", "cuenta de una de las dueñas"],
    ["Gabriela reaño vera", "147", "verified", "la misma en minúsculas"],
    ["Gabriela Rea*", "147", "partial", "recortada por la pantalla"],
    ["FRANKZ ALBERTO PAOLO KASTNER CAM", "481", "verified", "orden de la app"],
    ["KASTNER CAM FRANKZ ALBERTO PAOL", null, "partial", "orden del banco (alias)"],
    ["Kastner Ca*** Fr*** Al*** Pa***", null, "partial", "alias enmascarado"],

    // — lo que TIENE que seguir siendo un receptor distinto —
    ["Otro comercio", "309", "mismatch", "nombre ajeno"],
    ["GRUPO GF S.A.C.", "123", "mismatch", "celular de nadie"],
    ["Gabriela Reaño Vera", "309", "mismatch", "nombre de una, celular de otra"],
    ["Grupo Rf S", null, "mismatch", "una letra distinta"],
    ["Grupo Gf S A X Y", null, "mismatch", "palabras de más"],
    ["Grupo", null, "mismatch", "una palabra no distingue nada"],
    ["G", null, "mismatch", "una letra menos todavía"],
    ["BCP", null, "mismatch", "leyó el banco como titular"],
    // Estas dos son capturas de NUESTRO Yape, donde el nombre visible es el del
    // CLIENTE y no hay receptor que verificar. La lista de cuentas no las
    // resuelve —ni debe—: hacen falta la perspectiva del comprobante y el cruce
    // contra el cliente del pedido. Hasta entonces quedan en revisión, que es
    // la respuesta honesta.
    ["Elizabeth Sua*", "616", "mismatch", "captura entrante, pendiente"],
    ["WAYKI - ADOLFO MIGUEL ERNESTO EGUILUZ OCHOA", null, "mismatch", "captura entrante"],

    [null, null, "missing", "sin lectura"],
  ];

  for (const [name, phone, want, why] of corpus) {
    it(`${want}: ${why} — ${JSON.stringify(name)} / ${phone ?? "sin celular"}`, () => {
      expect(verifyYapeRecipient(name, phone).status).toBe(want);
    });
  }
});

describe("una tienda sin cuentas configuradas", () => {
  // La regla que no se puede romper. Si `store_collection_accounts` queda vacía
  // —tienda nueva, semilla que no corrió— "no sabemos contra qué contrastar" NO
  // puede convertirse en "el dinero se desvió": sería acusar de desvío a todos
  // los cobros de la tienda por un despiste de configuración.
  it("nunca acusa de desvío: cae en contraste manual", () => {
    const v = verifyAgainstAccounts("Quien Sea", "999", []);
    expect(v.status).toBe("partial");
    expect(v.unknownAccounts).toBe(true);
  });

  it("sin lectura y sin cuentas sigue siendo «falta el dato»", () => {
    expect(verifyAgainstAccounts(null, null, []).status).toBe("missing");
  });

  it("una cuenta mal cargada no cuenta como cuenta", () => {
    // Un celular que no son tres dígitos, o un nombre vacío, no pueden dejar la
    // verificación en pie a medias: se descartan y se cae en el mismo "no se
    // puede contrastar".
    const rotas = [
      { name: "", phoneLastDigits: "309" },
      { name: "Grupo GF S.A.C.", phoneLastDigits: "30" },
    ];
    expect(verifyAgainstAccounts("Otro comercio", "111", rotas).unknownAccounts).toBe(true);
  });
});

describe("la lectura que viene con el pagador y el receptor cambiados", () => {
  // KP129133, comprobante de S/ 212: el lector puso «Grupo Gf S.a.c.» —nuestra
  // cuenta— en `payer_name` y a la clienta en `recipient_name`. Saltó «Receptor
  // distinto» sobre un cobro impecable. La pista de cómo pasa está en que el
  // CELULAR sí lo leyó bien: encontró el bloque del receptor, sacó de ahí el
  // teléfono, y para el nombre se fue a otro bloque.
  const invertido = {
    extracted: {
      payer_name: "Grupo Gf S.a.c.",
      recipient_name: "Gloria Fujimotom",
      recipient_phone_last_digits: "309",
    },
  };

  it("detecta la inversión: nadie es las dos puntas del mismo Yape", () => {
    expect(readingLooksSwapped("Grupo Gf S.a.c.", "309", CUENTAS)).toBe(true);
  });

  it("el caso real deja de acusar de desvío y queda verificado", () => {
    const r = yapeRecipientReadingFromVision(invertido);
    expect(r.status).toBe("verified");
    expect(r.name).toBe("Grupo Gf S.a.c.");
    expect(r.swapped).toBe(true);
  });

  it("NO da por invertido un reembolso, donde sí somos quien paga", () => {
    // Ahí el receptor es la clienta y su celular no es de la tienda: no hay
    // contradicción, así que no hay nada que corregir. Exigir las dos puntas es
    // lo que separa un caso del otro.
    expect(readingLooksSwapped("Grupo Gf S.a.c.", "555", CUENTAS)).toBe(false);
    expect(readingLooksSwapped("Grupo Gf S.a.c.", null, CUENTAS)).toBe(false);
  });

  it("sin poder leer el celular no se afirma nada", () => {
    // Es el segundo de los dos casos invertidos que había en producción: sin la
    // otra punta no se puede demostrar la contradicción, y adivinar acá sería
    // reescribir el nombre del receptor de un cobro por una corazonada.
    const r = yapeRecipientReadingFromVision({
      extracted: { payer_name: "Grupo Gf S.a.c.", recipient_name: "Otra Persona" },
    });
    expect(r.swapped).toBe(false);
    expect(r.status).toBe("mismatch");
  });

  it("un pagador leído a medias no basta para invertir", () => {
    // Una lectura corta ya es dudosa; dar por invertido un comprobante con ella
    // sería apilar una suposición sobre otra.
    expect(readingLooksSwapped("Grupo Gf S", "309", CUENTAS)).toBe(false);
  });

  it("un pagador que no es ninguna cuenta nuestra no invierte nada", () => {
    expect(readingLooksSwapped("Gloria Fujimoto", "309", CUENTAS)).toBe(false);
  });

  it("una lectura normal sigue intacta", () => {
    const r = yapeRecipientReadingFromVision({
      extracted: {
        payer_name: "Gloria Fujimoto",
        recipient_name: "GRUPO GF S.A.C.",
        recipient_phone_last_digits: "309",
      },
    });
    expect(r.swapped).toBe(false);
    expect(r.status).toBe("verified");
  });

  it("sin cuentas configuradas no se inventa una inversión", () => {
    expect(readingLooksSwapped("Grupo Gf S.a.c.", "309", [])).toBe(false);
  });
});
