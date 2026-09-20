import { describe, expect, it } from "vitest";
import {
  nextOffer,
  passToNext,
  waitingMinutes,
  type AlertRouting,
  type EscalationStep,
} from "@/lib/collection-escalation";

const GERARDO = "u-gerardo";
const YOHALIS = "u-yohalis";
const FRANK = "u-frank";

/** La escalera de Kenku: Gerardo cobra, Yohalis cubre, Frank es el final. */
const ESCALERA: EscalationStep[] = [
  { userId: GERARDO, minutes: 30 },
  { userId: YOHALIS, minutes: 30 },
  { userId: FRANK, minutes: 30 },
];

const T0 = Date.parse("2026-09-20T15:00:00Z");
const min = (n: number) => T0 + n * 60_000;

const nueva: AlertRouting = { offeredTo: null, offeredAt: null, passed: [], claimedBy: null };

describe("nextOffer", () => {
  it("una alerta nueva va al primero de la escalera", () => {
    expect(nextOffer(nueva, ESCALERA, T0)).toEqual({ offeredTo: GERARDO, passed: [] });
  });

  it("dentro de sus minutos no se le quita a nadie", () => {
    const a = { ...nueva, offeredTo: GERARDO, offeredAt: "2026-09-20T15:00:00Z" };
    expect(nextOffer(a, ESCALERA, min(29))).toBeNull();
  });

  it("pasados sus minutos sube al siguiente, y queda anotado que dejó pasar", () => {
    const a = { ...nueva, offeredTo: GERARDO, offeredAt: "2026-09-20T15:00:00Z" };
    expect(nextOffer(a, ESCALERA, min(31))).toEqual({ offeredTo: YOHALIS, passed: [GERARDO] });
  });

  it("el ÚLTIMO escalón no escala: ahí se queda", () => {
    // Pasar de largo al final dejaría la alerta sin dueño, que es peor.
    const a = { ...nueva, offeredTo: FRANK, offeredAt: "2026-09-20T15:00:00Z", passed: [GERARDO, YOHALIS] };
    expect(nextOffer(a, ESCALERA, min(999))).toBeNull();
  });

  it("si ya la tomó alguien, no se mueve aunque venza", () => {
    const a = { ...nueva, offeredTo: GERARDO, offeredAt: "2026-09-20T15:00:00Z", claimedBy: GERARDO };
    expect(nextOffer(a, ESCALERA, min(999))).toBeNull();
  });

  it("sin escalera configurada no se ofrece a nadie, pero la alerta existe igual", () => {
    expect(nextOffer(nueva, [], T0)).toBeNull();
  });

  it("no mira si está conectado: espera sus minutos con el navegador cerrado", () => {
    // Es la diferencia deliberada con la alerta de asesoras. Aquí hay un
    // responsable, no una competencia por atender primero.
    const a = { ...nueva, offeredTo: GERARDO, offeredAt: "2026-09-20T15:00:00Z" };
    expect(nextOffer(a, ESCALERA, min(10))).toBeNull();
    expect(nextOffer(a, ESCALERA, min(31))).not.toBeNull();
  });

  it("si al de turno lo sacaron de la escalera, pasa ya al primero que quede", () => {
    // Su turno dejó de existir: esperar sus minutos sería esperar a nadie.
    const a = { ...nueva, offeredTo: "u-que-ya-no-esta", offeredAt: "2026-09-20T15:00:00Z" };
    expect(nextOffer(a, ESCALERA, min(1))).toEqual({ offeredTo: GERARDO, passed: [] });
  });

  it("respeta a quienes ya dejaron pasar", () => {
    const a = { ...nueva, offeredTo: GERARDO, offeredAt: "2026-09-20T15:00:00Z", passed: [YOHALIS] };
    expect(nextOffer(a, ESCALERA, min(31))).toEqual({ offeredTo: FRANK, passed: [YOHALIS, GERARDO] });
  });

  it("cada escalón puede tener sus propios minutos", () => {
    const rapida: EscalationStep[] = [
      { userId: GERARDO, minutes: 10 },
      { userId: YOHALIS, minutes: 45 },
    ];
    const a = { ...nueva, offeredTo: GERARDO, offeredAt: "2026-09-20T15:00:00Z" };
    expect(nextOffer(a, rapida, min(9))).toBeNull();
    expect(nextOffer(a, rapida, min(11))?.offeredTo).toBe(YOHALIS);
  });
});

describe("passToNext", () => {
  it("«no es mío» sube ya, sin esperar los minutos", () => {
    const a = { ...nueva, offeredTo: GERARDO, offeredAt: "2026-09-20T15:00:00Z" };
    expect(passToNext(a, ESCALERA)).toEqual({ offeredTo: YOHALIS, passed: [GERARDO] });
  });

  it("el último no puede pasársela a nadie: se queda con ella", () => {
    const a = { ...nueva, offeredTo: FRANK, offeredAt: "2026-09-20T15:00:00Z", passed: [GERARDO, YOHALIS] };
    expect(passToNext(a, ESCALERA)).toBeNull();
  });
});

describe("waitingMinutes", () => {
  it("cuenta lo que lleva esperando, para pintarlo", () => {
    expect(waitingMinutes("2026-09-20T15:00:00Z", min(47))).toBe(47);
    expect(waitingMinutes("no es fecha", min(47))).toBe(0);
  });
});
