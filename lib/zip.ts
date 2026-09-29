// Un .zip mínimo, sin compresión (método «stored»), para empaquetar unos pocos
// archivos de texto —la extensión de Chrome de Swayp— sin sumar dependencias.
// Cumple lo justo del formato PKZIP: cabecera local + datos por archivo, el
// directorio central y el registro final. Chrome y cualquier descompresor lo
// abren.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Empaqueta `{ "ruta/archivo": contenido }` en un .zip. */
export function zipSinCompresion(archivos: Record<string, string | Uint8Array>): Uint8Array {
  const enc = new TextEncoder();
  const locales: Uint8Array[] = [];
  const centrales: Uint8Array[] = [];
  let offset = 0;

  for (const [ruta, contenido] of Object.entries(archivos)) {
    const nombre = enc.encode(ruta);
    const datos = typeof contenido === "string" ? enc.encode(contenido) : contenido;
    const crc = crc32(datos);

    const local = new Uint8Array(30 + nombre.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); // firma de cabecera local
    l.setUint16(4, 20, true); // versión necesaria
    l.setUint16(6, 0x0800, true); // nombres en UTF-8
    l.setUint16(8, 0, true); // método: stored
    l.setUint16(10, 0, true); // hora
    l.setUint16(12, 0x21, true); // fecha (1980-01-01)
    l.setUint32(14, crc, true);
    l.setUint32(18, datos.length, true);
    l.setUint32(22, datos.length, true);
    l.setUint16(26, nombre.length, true);
    l.setUint16(28, 0, true);
    local.set(nombre, 30);

    const central = new Uint8Array(46 + nombre.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); // firma de directorio central
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, 0, true);
    c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, datos.length, true);
    c.setUint32(24, datos.length, true);
    c.setUint16(28, nombre.length, true);
    c.setUint32(42, offset, true); // dónde empieza su cabecera local
    central.set(nombre, 46);

    locales.push(local, datos);
    centrales.push(central);
    offset += local.length + datos.length;
  }

  const tamCentral = centrales.reduce((n, b) => n + b.length, 0);
  const fin = new Uint8Array(22);
  const f = new DataView(fin.buffer);
  f.setUint32(0, 0x06054b50, true); // fin del directorio central
  f.setUint16(8, centrales.length, true);
  f.setUint16(10, centrales.length, true);
  f.setUint32(12, tamCentral, true);
  f.setUint32(16, offset, true);

  const partes = [...locales, ...centrales, fin];
  const out = new Uint8Array(partes.reduce((n, b) => n + b.length, 0));
  let p = 0;
  for (const b of partes) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}
