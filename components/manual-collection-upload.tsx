"use client";

// «Cargar constancia de courier»: la constancia de cobro de una guía Tanders
// que llegó por WhatsApp y no está en Tanders (03-11-2026). Se busca por
// nuestro código de pedido o por la guía, se pega la imagen y entra a «Validar
// pagos». Reglas: lib/tanders/manual-collection.ts.

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { cn } from "@/components/ui";
import { Badge, Banner, CHECKBOX, FIELD, OpsButton, SECTION_CARD } from "@/components/ops-ui";
import { createBrowserSupabase } from "@/lib/supabase-browser";
import { globalPasteImage } from "@/lib/global-paste-image";
import {
  createCollectionUpload,
  findCollectionTargets,
  registerManualCollection,
  type CollectionTargetView,
} from "@/app/dashboard/pagos/constancia/actions";

const VOUCHER_BUCKET = "yape-vouchers";

function money(n: number | null): string {
  return n == null ? "—" : `S/ ${n.toFixed(2)}`;
}

function limaDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit" });
}

const DELIVERY_LABEL: Record<string, string> = {
  pendiente: "Pendiente",
  en_ruta: "En ruta",
  entregado: "Entregado",
  anulado: "Anulada",
};

export function ManualCollectionUpload() {
  const [query, setQuery] = useState("");
  const [targets, setTargets] = useState<CollectionTargetView[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [confirmCancelled, setConfirmCancelled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [searching, startSearch] = useTransition();
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const target = targets?.find((t) => t.shipmentId === selected) ?? null;
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  // Pegar se escucha en toda la ventana, como en «Registrar un pago»: la
  // imagen se copia en WhatsApp y se pega aquí sin buscar dónde hacer foco.
  useEffect(() => {
    if (!target || target.blockers.length) return;
    function onPaste(e: ClipboardEvent) {
      const f = globalPasteImage(e);
      if (f) {
        e.preventDefault();
        setFile(f);
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [target]);

  function search(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setTargets(null);
    setSelected(null);
    setFile(null);
    setConfirmCancelled(false);
    startSearch(async () => {
      const res = await findCollectionTargets(query);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setTargets(res.targets);
      // Con una sola guía no hay nada que elegir.
      if (res.targets.length === 1) setSelected(res.targets[0]!.shipmentId);
    });
  }

  async function register() {
    if (!target || !file) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const prep = await createCollectionUpload(target.shipmentId, file.type || "image/jpeg", file.name || "constancia.jpg");
      if ("error" in prep) {
        setError(prep.error);
        return;
      }
      const { error: upError } = await createBrowserSupabase()
        .storage.from(VOUCHER_BUCKET)
        .uploadToSignedUrl(prep.path, prep.token, file, { contentType: file.type || "image/jpeg" });
      if (upError) {
        setError(`No se pudo subir la imagen: ${upError.message}`);
        return;
      }
      const res = await registerManualCollection({ shipmentId: target.shipmentId, path: prep.path, confirmCancelled });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setNotice(res.notice);
      setTargets(null);
      setSelected(null);
      setFile(null);
      setConfirmCancelled(false);
      setQuery("");
    } finally {
      setSaving(false);
    }
  }

  const canRegister =
    Boolean(target && file) && !target?.blockers.length && (!target?.needsCancelConfirmation || confirmCancelled) && !saving;

  return (
    <section className={cn(SECTION_CARD, "space-y-4")}>
      <div>
        <h2 className="text-base font-semibold text-ink-900">Cargar constancia de courier</h2>
        <p className="mt-1 text-[13px] leading-5 text-ink-600">
          Para la constancia de cobro de una guía Tanders que no está en Tanders: la que te llegó por WhatsApp. Busca
          el pedido por nuestro código o por la guía, pega la imagen y entra a «Validar pagos» para que alguien la
          confirme.
        </p>
      </div>

      <form onSubmit={search} className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 space-y-1">
          <span className="text-xs font-medium text-ink-600">Pedido o guía de Tanders</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="#KP124940 o TANDER17852702234184882"
            className={FIELD}
            autoComplete="off"
          />
        </label>
        <OpsButton type="submit" disabled={searching || !query.trim()} className="pointer-coarse:h-11">
          {searching ? "Buscando…" : "Buscar"}
        </OpsButton>
      </form>

      {notice && (
        <Banner tone="ok" role="status">
          {notice}
        </Banner>
      )}
      {error && (
        <Banner tone="crit" role="alert">
          {error}
        </Banner>
      )}

      {targets && targets.length > 1 && (
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-ink-600">Elige la guía</legend>
          {targets.map((t) => (
            <label
              key={t.shipmentId}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-lg p-3 ring-1",
                selected === t.shipmentId ? "bg-brand-50 ring-brand-500" : "ring-line",
              )}
            >
              <input
                type="radio"
                name="guia"
                checked={selected === t.shipmentId}
                onChange={() => {
                  setSelected(t.shipmentId);
                  setConfirmCancelled(false);
                }}
              />
              <span className="font-mono text-[13px] text-ink-900">{t.guideCode}</span>
              <span className="text-[13px] text-ink-600">{DELIVERY_LABEL[t.deliveryStatus] ?? t.deliveryStatus}</span>
              {t.blockers.length > 0 && <Badge tone="neutral">No admite constancia</Badge>}
            </label>
          ))}
        </fieldset>
      )}

      {target && (
        <div className="space-y-3 rounded-lg bg-wash p-3">
          <dl className="grid gap-x-4 gap-y-2 text-[13px] sm:grid-cols-3">
            <div>
              <dt className="text-ink-500">Pedido</dt>
              <dd className="font-semibold text-ink-900">
                {target.orderName ?? "—"}
                {target.storeName ? <span className="font-normal text-ink-500"> · {target.storeName}</span> : null}
              </dd>
            </div>
            <div>
              <dt className="text-ink-500">Guía Tanders</dt>
              <dd className="font-mono text-ink-900">{target.guideCode}</dd>
            </div>
            <div>
              <dt className="text-ink-500">Cobro esperado</dt>
              <dd className="font-semibold text-ink-900">{money(target.expectedAmount)}</dd>
            </div>
            <div>
              <dt className="text-ink-500">Estado en Kapta</dt>
              <dd className="text-ink-900">{DELIVERY_LABEL[target.deliveryStatus] ?? target.deliveryStatus}</dd>
            </div>
            <div>
              <dt className="text-ink-500">Tanders dice</dt>
              <dd className="text-ink-900">{target.reportedStatus ?? "—"}</dd>
            </div>
          </dl>

          {target.blockers.map((b) => (
            <Banner key={b} tone="warn">
              {b}
            </Banner>
          ))}
          {target.warnings.map((w) => (
            <Banner key={w} tone="info">
              {w}
            </Banner>
          ))}

          {!target.blockers.length && (
            <>
              {target.needsCancelConfirmation && target.cancelledAt && (
                <Banner tone="warn" title={`Pedido anulado en la tienda el ${limaDate(target.cancelledAt)}`}>
                  <label className="mt-1 flex items-start gap-2">
                    <input
                      type="checkbox"
                      className={cn(CHECKBOX, "mt-0.5")}
                      checked={confirmCancelled}
                      onChange={(e) => setConfirmCancelled(e.target.checked)}
                    />
                    <span>
                      Confirmo que la caja se entregó y se cobró. Al validarla en «Validar pagos», el pedido se cierra como
                      venta cobrada.
                    </span>
                  </label>
                </Banner>
              )}

              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = Array.from(e.dataTransfer.files).find((x) => x.type.startsWith("image/"));
                  if (f) setFile(f);
                }}
                className="space-y-3 rounded-lg border border-dashed border-line-strong bg-white p-3"
              >
                {preview ? (
                  // eslint-disable-next-line @next/next/no-img-element -- imagen local, aún sin subir
                  <img src={preview} alt="Constancia elegida" className="max-h-80 rounded-md ring-1 ring-line" />
                ) : (
                  <p className="text-[13px] leading-5 text-ink-600">
                    Copia la imagen en WhatsApp y <strong className="font-semibold text-ink-900">pégala con Ctrl+V</strong>,
                    arrástrala aquí o elígela con el botón.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <OpsButton size="sm" type="button" onClick={() => inputRef.current?.click()} className="pointer-coarse:h-11">
                    {file ? "Cambiar imagen" : "Elegir imagen"}
                  </OpsButton>
                  <input
                    ref={inputRef}
                    type="file"
                    accept="image/*,.jpg,.jpeg,.png,.webp"
                    className="hidden"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                </div>
              </div>

              <OpsButton type="button" variant="primary" disabled={!canRegister} onClick={register} className="pointer-coarse:h-11">
                {saving ? "Leyendo y registrando…" : "Registrar constancia"}
              </OpsButton>
            </>
          )}
        </div>
      )}
    </section>
  );
}
