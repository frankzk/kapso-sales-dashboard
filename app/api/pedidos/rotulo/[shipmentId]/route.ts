import { NextResponse, type NextRequest } from "next/server";
import QRCode from "qrcode";
import { createServerSupabase } from "@/lib/db";
import { isCourierTbd, outputDisplayCode } from "@/lib/shipment-output";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function qrSvg(payload: string): string {
  const code = QRCode.create(payload, { errorCorrectionLevel: "M" });
  const size = code.modules.size;
  let path = "";
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (code.modules.get(row, column)) path += `M${column} ${row}h1v1h-1z`;
    }
  }
  return `<svg viewBox="-3 -3 ${size + 6} ${size + 6}" role="img" aria-label="QR de salida" shape-rendering="crispEdges"><rect x="-3" y="-3" width="${size + 6}" height="${size + 6}" fill="white"/><path d="${path}" fill="#020617"/></svg>`;
}

export async function GET(_request: NextRequest, context: { params: Promise<{ shipmentId: string }> }) {
  const { shipmentId } = await context.params;
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return new NextResponse("unauthorized", { status: 401 });

  const { data } = await sb
    .from("shipments")
    .select(
      "id,courier,guide_code,output_code,qr_token,order_name,customer_name,customer_phone,product,district,province,region,delivery_address,delivery_reference",
    )
    .eq("id", shipmentId)
    .maybeSingle();
  if (!data) return new NextResponse("forbidden", { status: 403 });

  const row = data as {
    courier: string;
    guide_code: string;
    output_code: string | null;
    qr_token: string | null;
    order_name: string | null;
    customer_name: string | null;
    customer_phone: string | null;
    product: string | null;
    district: string | null;
    province: string | null;
    region: string | null;
    delivery_address: string | null;
    delivery_reference: string | null;
  };
  const visibleCode = outputDisplayCode(row.output_code, row.courier) || row.guide_code;
  // Sin courier decidido, el rótulo lo dice: ese paquete todavía puede ir a
  // cualquier ruta, y el courier se fija al entrar a una (MOM §4).
  const courierLabel = isCourierTbd(row.courier) ? "Por definir" : row.courier;
  const payload = row.qr_token || row.output_code || row.guide_code;
  const destination = [row.district, row.province, row.region].filter(Boolean).join(" · ");

  const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Rótulo ${escapeHtml(visibleCode)}</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#e2e8f0;font-family:Arial,sans-serif;color:#020617}
    .toolbar{display:flex;justify-content:center;padding:16px}.toolbar button{border:0;border-radius:8px;background:#020617;color:white;padding:10px 18px;font-weight:700;cursor:pointer}
    .label{width:100mm;min-height:145mm;margin:0 auto 24px;background:white;padding:8mm;border:1px solid #cbd5e1;display:flex;flex-direction:column;gap:4mm}
    .top{display:flex;align-items:flex-start;justify-content:space-between;gap:8mm;border-bottom:2px solid #020617;padding-bottom:4mm}.brand{font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#475569}.code{font-size:22px;font-weight:900;line-height:1.05;margin-top:2mm}.courier{text-align:right;font-size:18px;font-weight:800;text-transform:uppercase}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:4mm}.field{border-bottom:1px solid #cbd5e1;padding-bottom:2mm}.field.full{grid-column:1/-1}.k{font-size:9px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.08em}.v{margin-top:1mm;font-size:13px;font-weight:700;line-height:1.3;overflow-wrap:anywhere}.address .v{font-size:15px}.qr{margin-top:auto;display:flex;align-items:center;justify-content:center;gap:7mm;border-top:2px solid #020617;padding-top:5mm}.qr svg{width:42mm;height:42mm}.qr-copy{max-width:40mm}.qr-copy strong{display:block;font-size:17px}.qr-copy span{display:block;margin-top:2mm;font-size:10px;color:#475569}.internal{font-family:monospace;font-size:9px;color:#64748b;overflow-wrap:anywhere}
    @page{size:100mm 150mm;margin:0}@media print{body{background:white}.toolbar{display:none}.label{margin:0;border:0;min-height:150mm;page-break-after:always}}
  </style>
</head>
<body>
  <div class="toolbar"><button type="button" onclick="window.print()">Imprimir rótulo</button></div>
  <main class="label">
    <header class="top"><div><div class="brand">Kapta · salida física</div><div class="code">${escapeHtml(visibleCode)}</div></div><div class="courier">${escapeHtml(courierLabel)}</div></header>
    <section class="grid">
      <div class="field"><div class="k">Pedido Shopify</div><div class="v">${escapeHtml(row.order_name || "—")}</div></div>
      <div class="field"><div class="k">Celular</div><div class="v">${escapeHtml(row.customer_phone || "—")}</div></div>
      <div class="field full"><div class="k">Cliente</div><div class="v">${escapeHtml(row.customer_name || "—")}</div></div>
      <div class="field full address"><div class="k">Dirección</div><div class="v">${escapeHtml(row.delivery_address || "—")}</div></div>
      <div class="field full"><div class="k">Distrito · Provincia · Región</div><div class="v">${escapeHtml(destination || "—")}</div></div>
      <div class="field full"><div class="k">Referencia</div><div class="v">${escapeHtml(row.delivery_reference || "—")}</div></div>
      <div class="field full"><div class="k">Productos</div><div class="v">${escapeHtml(row.product || "—")}</div></div>
    </section>
    <section class="qr">${qrSvg(payload)}<div class="qr-copy"><strong>Escanear en cada cotejo</strong><span>Este QR identifica esta salida, no el pedido completo.</span><span class="internal">${escapeHtml(payload)}</span></div></section>
  </main>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

