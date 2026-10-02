import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { requireUrpiStore } from "@/lib/urpi-programming-access";
import { readUrpiExcelWorkbook } from "@/lib/urpi-excel";
import { parseUrpiProgramming } from "@/lib/urpi-programming";
import { saveUrpiProgramming, type UrpiSource } from "@/lib/urpi-programming-db";

export const runtime = "nodejs";
export const maxDuration = 60;
const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(request: Request) {
  const startedAt = new Date().toISOString();
  try {
    // Reject oversized request before multipart parsing, including multipart overhead.
    if (Number(request.headers.get("content-length")) > MAX_BYTES + 65536) return NextResponse.json({ error: "El archivo supera 8 MB." }, { status: 413 });
    const form = await request.formData();
    const sourceId = String(form.get("sourceId") ?? "");
    const sb = await createServerSupabase();
    const { data, error } = await sb.from("urpi_programming_sources").select("*").eq("id", sourceId).maybeSingle();
    if (error || !data) return NextResponse.json({ error: "Archivo no encontrado o sin acceso." }, { status: 403 });
    const source = data as UrpiSource;
    const { user } = await requireUrpiStore(source.store_id);
    const file = form.get("file");
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".xlsx")) return NextResponse.json({ error: "Carga el libro mensual completo en formato .xlsx." }, { status: 400 });
    if (!file.size || file.size > MAX_BYTES) return NextResponse.json({ error: "El archivo debe pesar entre 1 byte y 8 MB." }, { status: 413 });
    const workbook = await readUrpiExcelWorkbook(await file.arrayBuffer());
    const parsed = parseUrpiProgramming(workbook, source.month, source.order_prefix);
    const result = await saveUrpiProgramming(createAdminSupabase(), source, parsed, { actor: user.id, startedAt, origin: "excel", filename: file.name.slice(0, 200) });
    revalidatePath("/dashboard/urpi");
    return NextResponse.json({ ok: true, message: `${result.changed ? "Programación importada" : "Sin cambios"}: ${result.rows} registros, ${result.linked} vinculados a Kapta.` });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "No se pudo importar el archivo." }, { status: 400 });
  }
}
