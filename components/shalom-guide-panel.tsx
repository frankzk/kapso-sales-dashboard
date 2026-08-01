"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { Card } from "@/components/ui";
import { PickupKeyPanel } from "@/components/pickup-key-panel";
import {
  createShalomGuide,
  previewShalomGuide,
  type ShalomGuidePreview,
} from "@/app/dashboard/pedidos/shalom-actions";
import {
  selectDefaultAgencyPackageSize,
  validateAgencyDocument,
} from "@/lib/aliclik-agency";

export function ShalomGuidePanel({
  orderId,
  onCreated,
}: {
  orderId: string;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<ShalomGuidePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [agencySearch, setAgencySearch] = useState("");
  const [agencyId, setAgencyId] = useState("");
  const [packageSize, setPackageSize] = useState("");
  const [scheduleDate, setScheduleDate] = useState("");
  const [receiverName, setReceiverName] = useState("");
  const [receiverPhone, setReceiverPhone] = useState("");
  const [documentType, setDocumentType] = useState<"DNI" | "CE">("DNI");
  const [documentNumber, setDocumentNumber] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const result = await previewShalomGuide(orderId);
    setPreview(result);
    if (result.ok) {
      setAgencyId((value) => value || result.suggestedAgencyId || "");
      setPackageSize((value) =>
        value || selectDefaultAgencyPackageSize(result.packageSizes ?? []),
      );
      setScheduleDate((value) => value || result.scheduleDate || "");
      setReceiverName((value) => value || result.receiverName || "");
      setReceiverPhone((value) => value || result.receiverPhone || "");
    }
    setLoading(false);
  }, [orderId]);

  useEffect(() => {
    if (open && !preview && !loading) void load();
  }, [open, preview, loading, load]);

  const agencies = useMemo(() => {
    const query = agencySearch.trim().toLowerCase();
    const rows = preview?.agencies ?? [];
    if (!query) return rows;
    return rows.filter((agency) =>
      [agency.name, agency.address, agency.district, agency.province, agency.department]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [agencySearch, preview?.agencies]);

  const chosenAgency = preview?.agencies?.find((agency) => agency.id === agencyId) ?? null;
  const documentValidation = useMemo(
    () => validateAgencyDocument(documentType, documentNumber),
    [documentType, documentNumber],
  );
  const canCreate = Boolean(
    preview?.ok &&
      preview.advanceReady &&
      !preview.writeBlocked &&
      agencyId &&
      packageSize &&
      scheduleDate &&
      receiverName.trim() &&
      receiverPhone.trim() &&
      documentValidation.ok,
  );

  function create() {
    if (!canCreate) return;
    setMessage(null);
    startTransition(async () => {
      const result = await createShalomGuide(orderId, {
        agencyId,
        packageSize,
        scheduleDate,
        receiverName,
        receiverPhone,
        documentType,
        documentNumber,
      });
      if (result.error) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      setMessage({ kind: "ok", text: result.notice ?? "Guía Shalom creada." });
      onCreated();
    });
  }

  return (
    <Card>
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-900">Guía de Agencia Shalom</h3>
              <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                Agencia recomendada
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              El cliente recoge en Shalom. No necesita coordenadas ni cotización de reparto.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="shrink-0 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
          >
            {open ? "Cerrar" : "Generar guía"}
          </button>
        </div>

        {open ? (
          <div className="space-y-4 border-t border-slate-200 pt-4">
            {loading ? <p className="text-sm text-slate-500">Preparando formulario Shalom…</p> : null}

            {preview && !preview.ok ? (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 whitespace-pre-line">
                {preview.error ?? "No se pudo preparar la guía Shalom."}
                <button
                  type="button"
                  onClick={() => void load()}
                  className="mt-2 block rounded-md border border-rose-200 bg-white px-2.5 py-1 text-xs font-medium"
                >
                  Reintentar
                </button>
              </div>
            ) : null}

            {preview?.ok ? (
              <>
                <div
                  className={`rounded-lg border px-3 py-2.5 ${
                    preview.advanceReady
                      ? "border-emerald-200 bg-emerald-50"
                      : "border-amber-200 bg-amber-50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium text-slate-800">Adelanto validado</span>
                    <span className={preview.advanceReady ? "font-semibold text-emerald-700" : "font-semibold text-amber-800"}>
                      S/ {(preview.validatedAdvance ?? 0).toFixed(2)} de S/ {(preview.requiredAdvance ?? 30).toFixed(2)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-600">
                    {preview.advanceReady
                      ? "Listo: el adelanto permite generar la guía. La clave seguirá bloqueada hasta completar el pago."
                      : "Carga y valida el adelanto antes de generar la guía."}
                  </p>
                </div>

                {!preview.advanceReady ? (
                  <PickupKeyPanel
                    orderId={orderId}
                    onChanged={() => {
                      void load();
                      onCreated();
                    }}
                  />
                ) : null}

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="sm:col-span-2">
                    <span className="mb-1 block text-xs font-medium text-slate-600">Buscar agencia destino</span>
                    <input
                      value={agencySearch}
                      onChange={(event) => setAgencySearch(event.target.value)}
                      placeholder="Distrito, provincia, nombre o dirección"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </label>

                  <label className="sm:col-span-2">
                    <span className="mb-1 block text-xs font-medium text-slate-600">Agencia Shalom</span>
                    <select
                      value={agencyId}
                      onChange={(event) => setAgencyId(event.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                    >
                      <option value="">Selecciona la agencia donde recogerá el cliente</option>
                      {agencies.map((agency) => (
                        <option key={agency.id} value={agency.id}>
                          {[agency.department, agency.province, agency.district, agency.name, agency.address]
                            .filter(Boolean)
                            .join(" · ")}
                        </option>
                      ))}
                    </select>
                    {agencySearch && agencies.length === 0 ? (
                      <p className="mt-1 text-xs text-amber-700">No hay agencias que coincidan con esa búsqueda.</p>
                    ) : null}
                    {chosenAgency ? (
                      <p className="mt-1 text-xs text-slate-500">Destino: {chosenAgency.address}</p>
                    ) : null}
                  </label>

                  <label>
                    <span className="mb-1 block text-xs font-medium text-slate-600">Tamaño del paquete</span>
                    <select
                      value={packageSize}
                      onChange={(event) => setPackageSize(event.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                    >
                      {(preview.packageSizes ?? []).map((size) => (
                        <option key={size} value={size}>{size}</option>
                      ))}
                    </select>
                  </label>

                  <label>
                    <span className="mb-1 block text-xs font-medium text-slate-600">Fecha de despacho</span>
                    <input
                      type="date"
                      value={scheduleDate}
                      min={preview.scheduleDate}
                      onChange={(event) => setScheduleDate(event.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                    {preview.scheduleMessage ? (
                      <p className="mt-1 text-xs text-amber-700">{preview.scheduleMessage}</p>
                    ) : null}
                  </label>

                  <label className="sm:col-span-2">
                    <span className="mb-1 block text-xs font-medium text-slate-600">Persona que recogerá</span>
                    <input
                      value={receiverName}
                      onChange={(event) => setReceiverName(event.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </label>

                  <label>
                    <span className="mb-1 block text-xs font-medium text-slate-600">Celular</span>
                    <input
                      inputMode="tel"
                      value={receiverPhone}
                      onChange={(event) => setReceiverPhone(event.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </label>

                  <div>
                    <span className="mb-1 block text-xs font-medium text-slate-600">Documento</span>
                    <div className="flex gap-2">
                      <select
                        value={documentType}
                        onChange={(event) => setDocumentType(event.target.value as "DNI" | "CE")}
                        className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm"
                      >
                        <option value="DNI">DNI</option>
                        <option value="CE">CE</option>
                      </select>
                      <input
                        inputMode="numeric"
                        value={documentNumber}
                        onChange={(event) => setDocumentNumber(event.target.value.replace(/\D/g, ""))}
                        maxLength={documentType === "DNI" ? 8 : 12}
                        placeholder={documentType === "DNI" ? "8 dígitos" : "Número de CE"}
                        aria-invalid={Boolean(documentNumber) && !documentValidation.ok}
                        className={`min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm ${
                          documentNumber && !documentValidation.ok
                            ? "border-rose-300 bg-rose-50"
                            : documentValidation.ok
                              ? "border-emerald-300 bg-emerald-50"
                              : "border-slate-300"
                        }`}
                      />
                    </div>
                    <p
                      className={`mt-1 text-xs ${
                        !documentNumber
                          ? "text-slate-500"
                          : documentValidation.ok
                            ? "text-emerald-700"
                            : "text-rose-700"
                      }`}
                    >
                      {!documentNumber
                        ? "Se comprobará el formato antes de crear la guía; no consulta RENIEC."
                        : documentValidation.ok
                          ? `✓ ${documentValidation.message}`
                          : documentValidation.message}
                    </p>
                  </div>

                </div>

                {preview.warnings?.map((warning) => (
                  <p key={warning} className="text-xs text-amber-700">⚠ {warning}</p>
                ))}

                {message ? (
                  <p
                    className={`whitespace-pre-line rounded-lg border px-3 py-2 text-sm ${
                      message.kind === "ok"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                        : "border-rose-200 bg-rose-50 text-rose-700"
                    }`}
                  >
                    {message.text}
                  </p>
                ) : null}

                <button
                  type="button"
                  onClick={create}
                  disabled={pending || !canCreate}
                  className="w-full rounded-lg bg-blue-700 px-3 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pending ? "Creando guía Shalom…" : "Crear guía de Agencia Shalom"}
                </button>
                <p className="text-center text-xs text-slate-500">
                  {preview.writeBlocked ??
                    (!preview.advanceReady
                      ? "El botón se habilitará cuando el adelanto llegue a S/ 30.00 y esté validado."
                      : "La clave se crea cifrada y no se libera hasta validar el pago completo.")}
                </p>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
