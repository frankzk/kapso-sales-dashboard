// Memoria con caducidad para lo que se lee mil veces y cambia una.
//
// POR QUÉ. Cada recálculo del Master descargaba las 745 tarifas de la
// organización: 45.000 recálculos al día, 33 millones de filas de `cost_tariffs`
// servidas en 24 horas, la partida más grande del egress de Supabase. Las
// tarifas cambian cuando alguien las edita —semanas—; leerlas cada vez era
// pagar por no recordar. Una instancia de Vercel vive minutos u horas entre
// invocaciones, así que recordar dentro de ella ya evita casi todas las
// lecturas; entre instancias no se comparte, y no hace falta.
//
// LO QUE CUESTA. Una tarifa editada tarda hasta `ttlMs` en verse en los
// recálculos de una instancia caliente. Es un costo por pedido, no un estado:
// el siguiente recálculo la corrige sola.

export interface TtlCache<T> {
  get(key: string, now: number, load: () => Promise<T>): Promise<T>;
  /** Para pruebas y para quien edite la fuente en la misma instancia. */
  clear(): void;
}

export function ttlCache<T>(ttlMs: number): TtlCache<T> {
  let entry: { key: string; at: number; value: T } | null = null;
  return {
    async get(key, now, load) {
      if (entry && entry.key === key && now - entry.at < ttlMs) return entry.value;
      const value = await load();
      entry = { key, at: now, value };
      return value;
    },
    clear() {
      entry = null;
    },
  };
}
