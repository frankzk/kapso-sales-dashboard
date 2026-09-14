"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DispatchCamera } from "@/components/dispatch-camera";
import { receiveMyGfPackage } from "@/app/reparto/receive";
import type { RiderLoad } from "@/lib/gf-rider-loads";

export function GfRiderReceipt({ loads }: { loads: RiderLoad[] }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [camera, setCamera] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [pending, start] = useTransition();
  const scanning = useRef(false);
  function receive(id: string, value: string) {
    if (scanning.current || !value.trim()) return;
    scanning.current = true;
    start(async () => {
      try {
        const result = await receiveMyGfPackage(id, value);
        setMessage(result.error ?? result.notice ?? "");
        if (!result.error) { setCode(""); router.refresh(); }
      } catch {
        setMessage("No pudimos confirmar la recepción. Reintenta el mismo código; no se duplicará.");
      } finally { scanning.current = false; }
    });
  }
  return <section className="mx-auto max-w-md space-y-3 p-4" aria-label="Grupo GF Courier: recibir mi carga">
    {!!loads.length && <h2 className="font-semibold">Grupo GF Courier · Recibir mi carga</h2>}
    {message && <p role="status" className="rounded-lg bg-slate-100 p-3 text-sm">{message}</p>}
    {loads.map((load) => <form key={load.id} onSubmit={(event) => { event.preventDefault(); receive(load.id, code); }} className="space-y-3 rounded-xl border bg-white p-4">
      <p className="font-medium">{load.route_date} · Carga {load.load_number}</p>
      <p className="text-sm">{load.received} de {load.total} paquetes recibidos. Escanea cada paquete que te entregan.</p>
      <input aria-label="QR del paquete recibido" value={code} onChange={(event) => setCode(event.target.value)} className="h-12 w-full rounded-lg border px-3" placeholder="QR o código del paquete" disabled={pending} />
      <div className="flex gap-2"><button disabled={pending || !code.trim()} className="min-h-12 rounded-lg bg-blue-700 px-4 text-white disabled:opacity-40">Recibir paquete</button>
      <button type="button" onClick={() => setCamera(load.id)} className="min-h-12 rounded-lg border px-4">Abrir cámara</button></div>
    </form>)}
    <DispatchCamera open={!!camera} onClose={() => setCamera(null)} onScan={(value) => { if (camera) receive(camera, value); }} />
  </section>;
}
