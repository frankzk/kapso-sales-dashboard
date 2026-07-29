"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  connectShalomSession,
  createShalomGuide,
  loadShalomDraft,
  loadShalomProducts,
  lookupShalomPerson,
  quoteShalomTariff,
  searchShalomAgencies,
  type ShalomDraftView,
} from "@/app/dashboard/pedidos/shalom-actions";
import {
  documentError,
  needsCustomDimensions,
  pickupCodeError,
  DEFAULT_DECLARACION,
  DEFAULT_PAYER,
} from "@/lib/shalom/draft";
import {
  DECLARACIONES_JURADAS,
  type DeclaracionJurada,
  type ShalomAgency,
  type ShalomDocumentType,
  type ShalomPayer,
  type ShalomProduct,
} from "@/lib/shalom/types";

/**
 * Crear una preguía de Shalom desde el drawer del Master.
 *
 * El orden de la pantalla sigue el de la API, que no es arbitrario:
 *
 *  1. CONECTAR. El wrapper hace un login real contra pro.shalom.pe y tarda hasta
 *     2 minutos la primera vez. Es un paso visible y con su propio aviso porque
 *     si no, parece que la aplicación se colgó. Dura 2 h: la segunda guía del
 *     día no lo vuelve a pagar.
 *  2. AGENCIA DE DESTINO. Se busca por texto; solo pide la API key, así que
 *     funciona incluso antes de conectar.
 *  3. DESTINATARIO. Shalom lo identifica por documento y el pedido no lo trae
 *     (Shopify no pide DNI). Al escribirlo se consulta /v1/persons/search y, si
 *     el cliente ya envió antes por Shalom, se rellenan nombre y apellidos.
 *  4. PAQUETE. El catálogo es por cuenta, así que se lista en vivo.
 *
 * La clave de recojo NO se pide ni se muestra: la genera el servidor y va
 * cifrada a la tabla de siempre. Quien crea la guía no necesita verla — se
 * revela desde el panel de pagos cuando el cobro está validado, con auditoría.
 * Solo un rol que ya puede ver claves la ve acá.
 */
export function ShalomGuideModal({
  orderId,
  onClose,
  onCreated,
}: {
  orderId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [draft, setDraft] = useState<ShalomDraftView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Sesión
  const [sessionReady, setSessionReady] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  // Agencia de destino
  const [agencyQuery, setAgencyQuery] = useState("");
  const [agencies, setAgencies] = useState<ShalomAgency[]>([]);
  const [agencySearching, setAgencySearching] = useState(false);
  const [agency, setAgency] = useState<ShalomAgency | null>(null);

  // Destinatario
  const [documentType, setDocumentType] = useState<ShalomDocumentType>("DNI");
  const [documentValue, setDocumentValue] = useState("");
  const [name, setName] = useState("");
  const [lastName, setLastName] = useState("");
  const [surName, setSurName] = useState("");
  const [phone, setPhone] = useState("");
  const [personNotice, setPersonNotice] = useState<string | null>(null);

  // Paquete
  const [products, setProducts] = useState<ShalomProduct[]>([]);
  const [productId, setProductId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [payer, setPayer] = useState<ShalomPayer>(DEFAULT_PAYER);
  const [declaracion, setDeclaracion] = useState<DeclaracionJurada>(DEFAULT_DECLARACION);
  const [dims, setDims] = useState({ weight_kg: "", height_m: "", length_m: "", width_m: "" });
  const [pickupCode, setPickupCode] = useState("");

  const [quote, setQuote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ notice: string; code: string } | null>(null);
  const [pending, start] = useTransition();

  // ── Carga inicial ─────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await loadShalomDraft(orderId);
      if (!alive) return;
      if ("error" in res) {
        setLoadError(res.error);
        return;
      }
      const d = res.draft;
      setDraft(d);
      setSessionReady(d.sessionReady);
      setAgencyQuery(d.agencyQuery);
      setName(d.receiverName);
      setLastName(d.receiverLastName);
      setSurName(d.receiverSurName);
      setPhone(d.receiverPhone ?? "");
      setProductId(d.defaultProductId);
      if (d.pickupCode) setPickupCode(d.pickupCode);

      // Lo apuntado al registrar el pago (0073). Es el punto de todo esto: quien
      // cobró tenía a la clienta al teléfono; quien crea la guía, no. Puede venir
      // a medias —el DNI sí y la agencia no—, así que cada campo se rellena por
      // separado y todos quedan editables: es un adelanto, no una imposición.
      if (d.prefilledDocument) {
        setDocumentValue(d.prefilledDocument);
        if (d.prefilledDocumentType) setDocumentType(d.prefilledDocumentType);
      }
      if (d.prefilledTerminalId) {
        setAgency({
          id: d.prefilledTerminalId,
          nombre: d.prefilledTerminalName ?? `Agencia ${d.prefilledTerminalId}`,
        });
        // Con la agencia ya elegida no hace falta gastar una búsqueda del cupo
        // compartido solo para volver a encontrar lo que ya sabemos.
        setAgencyQuery("");
      }
    })();
    return () => {
      alive = false;
    };
  }, [orderId]);

  const storeId = draft?.storeId ?? null;

  // ── Búsqueda de agencias (con rebote: el rate limit son 60/min) ───────────
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!storeId || agency) return;
    const q = agencyQuery.trim();
    if (q.length < 2) {
      setAgencies([]);
      return;
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setAgencySearching(true);
      void searchShalomAgencies(storeId, q).then((res) => {
        setAgencySearching(false);
        if ("error" in res) {
          setError(res.error);
          return;
        }
        setAgencies(res.agencies);
      });
    }, 450);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [agencyQuery, storeId, agency]);

  // ── Productos: en cuanto hay sesión ───────────────────────────────────────
  useEffect(() => {
    if (!storeId || !sessionReady || products.length > 0) return;
    void loadShalomProducts(storeId).then((res) => {
      if ("error" in res) return; // No es bloqueante: se puede escribir el id.
      setProducts(res.products);
    });
  }, [storeId, sessionReady, products.length]);

  const connect = useCallback(() => {
    if (!storeId) return;
    setConnecting(true);
    setSessionError(null);
    void connectShalomSession(storeId).then((res) => {
      setConnecting(false);
      if ("error" in res) {
        setSessionError(res.error);
        return;
      }
      setSessionReady(true);
    });
  }, [storeId]);

  // ── Autocompletar destinatario por documento ──────────────────────────────
  const docErr = documentValue.trim() ? documentError(documentType, documentValue) : null;

  function lookupDocument() {
    if (!storeId || docErr) return;
    setPersonNotice(null);
    void lookupShalomPerson(storeId, documentValue.trim(), documentType).then((res) => {
      if ("error" in res) {
        setPersonNotice(res.error);
        return;
      }
      if (!res.person) {
        setPersonNotice("No figura en Shalom Pro: se registrará con los datos de abajo.");
        return;
      }
      setName(res.person.name || name);
      setLastName(res.person.lastName || lastName);
      setSurName(res.person.surName || surName);
      if (res.person.phone) setPhone(res.person.phone);
      setPersonNotice("Ya registrado en Shalom Pro: se reusan sus datos.");
    });
  }

  function fetchQuote() {
    if (!storeId || !agency) return;
    setQuote(null);
    void quoteShalomTariff(storeId, {
      destinyTerminalId: agency.id,
      productId: productId ?? undefined,
    }).then((res) => {
      if ("error" in res) {
        setQuote(res.error);
        return;
      }
      setQuote(
        res.price != null
          ? `${res.currency} ${res.price.toFixed(2)} para el paquete elegido.`
          : `Sin precio puntual; tarifas: ${Object.entries(res.breakdown)
              .map(([k, v]) => `${k} ${v}`)
              .join(" · ")}`,
      );
    });
  }

  const selectedProduct = useMemo(
    () => products.find((p) => p.id === productId) ?? null,
    [products, productId],
  );
  const wantsDims = needsCustomDimensions(selectedProduct?.title);
  const [overrideReason, setOverrideReason] = useState("");
  const canSeeKey = Boolean(draft?.pickupCode);
  const keyErr = canSeeKey && pickupCode ? pickupCodeError(pickupCode) : null;

  const blocked = (draft?.blockers.length ?? 0) > 0;
  // Freno blando: deshabilita, pero se levanta escribiendo un motivo. El mínimo
  // existe porque "ok" o "." no explican nada a quien lea esto en un mes.
  const soft = draft?.softBlockers ?? [];
  const softHeld = soft.length > 0 && overrideReason.trim().length < 10;
  const canSubmit = Boolean(
    draft &&
      !blocked &&
      !softHeld &&
      sessionReady &&
      agency &&
      productId &&
      documentValue.trim() &&
      !docErr &&
      !keyErr &&
      name.trim() &&
      phone.trim() &&
      !pending &&
      !created,
  );

  function submit() {
    if (!agency || !productId) return;
    start(async () => {
      const parsedDims =
        wantsDims && dims.weight_kg
          ? {
              weight_kg: Number(dims.weight_kg) || 0,
              height_m: Number(dims.height_m) || 0,
              length_m: Number(dims.length_m) || 0,
              width_m: Number(dims.width_m) || 0,
            }
          : null;

      const res = await createShalomGuide(orderId, {
        destinyTerminalId: agency.id,
        destinyTerminalName: agency.nombre,
        productId,
        quantity: Number(quantity) || 1,
        payer,
        declaracionJurada: declaracion,
        documentType,
        document: documentValue.trim(),
        name: name.trim(),
        lastName: lastName.trim(),
        surName: surName.trim(),
        phone: phone.trim(),
        overrideReason: overrideReason.trim() || null,
        dimensions: parsedDims,
        ...(canSeeKey && pickupCode ? { pickupCode } : {}),
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      setError(null);
      setCreated({ notice: res.notice ?? "", code: res.guideCode ?? "" });
      onCreated();
    });
  }

  return (
    // El modal se monta DENTRO del drawer, que cierra al hacer click en su
    // fondo: sin frenar la propagación, cerrar el modal cerraría también el
    // pedido y el operador perdería el contexto.
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-full w-full max-w-lg overflow-y-auto rounded-xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">Crear guía Shalom</p>
            <p className="text-xs text-slate-500">
              {draft?.orderName ?? "Pedido"}
              {draft?.originTerminalName ? ` · desde ${draft.originTerminalName}` : ""}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
            ✕
          </button>
        </div>

        {loadError && (
          <p className="m-5 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>
        )}
        {!draft && !loadError && <p className="p-5 text-sm text-slate-400">Cargando…</p>}

        {draft && (
          <div className="space-y-4 p-5">
            {draft.blockers.map((b) => (
              <p key={b} className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {b}
              </p>
            ))}
            {draft.warnings.map((w) => (
              <p key={w} className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {w}
              </p>
            ))}

            {/* Freno blando: no es un aviso más ni un muro. Se explica, se pide
                el motivo, y el motivo queda con nombre en la línea de tiempo.
                El servidor exige lo mismo: el botón solo es la cortesía. */}
            {soft.length > 0 && !created && (
              <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 px-3 py-3">
                {soft.map((b) => (
                  <p key={b} className="text-sm text-red-800">
                    {b}
                  </p>
                ))}
                <label className="block">
                  <span className="text-xs font-medium text-red-800">
                    Motivo para crearla igual (queda registrado con tu nombre)
                  </span>
                  <textarea
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    rows={2}
                    placeholder="Ej.: la clienta pagó completo por transferencia, comprobante en el grupo"
                    className="mt-1 w-full rounded-lg border border-red-300 px-3 py-2 text-sm"
                  />
                  {softHeld && (
                    <span className="mt-1 block text-xs text-red-700">
                      Escribe al menos 10 caracteres para poder crear la guía.
                    </span>
                  )}
                </label>
              </div>
            )}

            {created ? (
              <div className="space-y-2 rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
                <p>
                  Guía creada: <span className="font-mono">{created.code}</span>
                </p>
                <p className="text-emerald-700">{created.notice}</p>
                <button onClick={onClose} className="text-emerald-900 underline">
                  Cerrar
                </button>
              </div>
            ) : (
              <>
                {/* 1. Sesión */}
                <div className="rounded-lg border border-slate-200 px-3 py-3">
                  {sessionReady ? (
                    <p className="text-xs text-emerald-700">
                      ✓ Conectado a Shalom Pro. La sesión dura 2 horas.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-xs text-slate-600">
                        Hay que conectar la cuenta de Shalom Pro antes de crear la guía.{" "}
                        <strong>La primera conexión tarda hasta 2 minutos</strong> porque Shalom hace
                        un inicio de sesión real; después queda lista por 2 horas.
                      </p>
                      <button
                        onClick={connect}
                        disabled={connecting || !draft.configured}
                        className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                      >
                        {connecting ? "Conectando… (puede tardar 2 min)" : "Conectar con Shalom"}
                      </button>
                      {sessionError && <p className="text-xs text-red-600">{sessionError}</p>}
                    </div>
                  )}
                </div>

                {/* 2. Agencia de destino */}
                <Field
                  label="Agencia de destino"
                  hint="Búsqueda por texto sobre el directorio de Shalom (distrito, provincia o nombre de la agencia)."
                >
                  {agency ? (
                    <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
                      <span>
                        <span className="font-medium">{agency.nombre}</span>{" "}
                        <span className="text-slate-500">#{agency.id}</span>
                        {agency.departamento ? (
                          <span className="block text-xs text-slate-500">
                            {[agency.departamento, agency.provincia, agency.distrito]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        ) : null}
                      </span>
                      <button
                        onClick={() => {
                          setAgency(null);
                          setQuote(null);
                        }}
                        className="text-xs text-slate-500 underline"
                      >
                        cambiar
                      </button>
                    </div>
                  ) : (
                    <>
                      <input
                        value={agencyQuery}
                        onChange={(e) => setAgencyQuery(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        placeholder="arequipa"
                      />
                      {agencySearching && <p className="mt-1 text-xs text-slate-400">Buscando…</p>}
                      {agencies.length > 0 && (
                        <ul className="mt-1 max-h-44 overflow-y-auto rounded-lg border border-slate-200">
                          {agencies.map((a) => (
                            <li key={a.id}>
                              <button
                                onClick={() => setAgency(a)}
                                className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                              >
                                <span className="font-medium">{a.nombre}</span>{" "}
                                <span className="text-xs text-slate-500">#{a.id}</span>
                                <span className="block text-xs text-slate-500">
                                  {[a.departamento, a.provincia, a.distrito].filter(Boolean).join(" · ")}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </Field>

                {/* 3. Destinatario */}
                <div className="grid grid-cols-[7rem_1fr] gap-3">
                  <Field label="Tipo doc.">
                    <select
                      value={documentType}
                      onChange={(e) => setDocumentType(e.target.value as ShalomDocumentType)}
                      className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
                    >
                      <option value="DNI">DNI</option>
                      <option value="RUC">RUC</option>
                      <option value="CE">CE</option>
                    </select>
                  </Field>
                  <Field label="Documento del destinatario">
                    <div className="flex gap-2">
                      <input
                        value={documentValue}
                        onChange={(e) => setDocumentValue(e.target.value)}
                        onBlur={lookupDocument}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        placeholder="70123456"
                      />
                      <button
                        onClick={lookupDocument}
                        disabled={!sessionReady || Boolean(docErr) || !documentValue.trim()}
                        className="shrink-0 rounded-lg border border-slate-300 px-2.5 text-xs text-slate-700 disabled:opacity-40"
                      >
                        Buscar
                      </button>
                    </div>
                    {docErr && <p className="mt-1 text-xs text-red-600">{docErr}</p>}
                    {personNotice && <p className="mt-1 text-xs text-slate-500">{personNotice}</p>}
                  </Field>
                </div>

                <Field
                  label={documentType === "RUC" ? "Razón social" : "Nombres"}
                  hint={
                    documentType === "RUC"
                      ? "La razón social completa va en un solo campo."
                      : "Sugerido a partir del nombre del pedido: verifica los apellidos."
                  }
                >
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </Field>

                {documentType !== "RUC" && (
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Primer apellido">
                      <input
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </Field>
                    <Field label="Segundo apellido">
                      <input
                        value={surName}
                        onChange={(e) => setSurName(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </Field>
                  </div>
                )}

                <Field label="Teléfono" hint="Celular peruano de 9 dígitos.">
                  <input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    placeholder="981535978"
                  />
                </Field>

                {/* 4. Paquete */}
                <div className="grid grid-cols-[1fr_5rem] gap-3">
                  <Field label="Tipo de paquete">
                    {products.length > 0 ? (
                      <select
                        value={productId ?? ""}
                        onChange={(e) => setProductId(Number(e.target.value) || null)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      >
                        <option value="">— elegir —</option>
                        {/* El catálogo de la cuenta repite ids: Shalom devuelve
                            id=2 para «Caja Paquete L» y para «Otra Medida». El
                            id no sirve como clave. */}
                        {products.map((p, i) => (
                          <option key={`${p.id}-${i}`} value={p.id}>
                            {p.title}
                            {p.content ? ` — ${p.content}` : ""}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={productId ?? ""}
                        onChange={(e) => setProductId(Number(e.target.value) || null)}
                        inputMode="numeric"
                        placeholder="id de producto"
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    )}
                  </Field>
                  <Field label="Bultos">
                    <input
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                      inputMode="numeric"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </Field>
                </div>

                {wantsDims && (
                  <Field
                    label="Medidas (solo «Otra Medida»)"
                    hint="Peso en kg, medidas en metros."
                  >
                    <div className="grid grid-cols-4 gap-2">
                      {(["weight_kg", "height_m", "length_m", "width_m"] as const).map((k) => (
                        <input
                          key={k}
                          value={dims[k]}
                          onChange={(e) => setDims({ ...dims, [k]: e.target.value })}
                          inputMode="decimal"
                          placeholder={k.replace(/_/g, " ")}
                          className="w-full rounded-lg border border-slate-300 px-2 py-2 text-xs"
                        />
                      ))}
                    </div>
                  </Field>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <Field label="Paga el flete">
                    <select
                      value={payer}
                      onChange={(e) => setPayer(e.target.value as ShalomPayer)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    >
                      <option value="sender">Remitente (al despachar)</option>
                      <option value="receiver">Destinatario (contra entrega)</option>
                    </select>
                  </Field>
                  <Field label="Declaración jurada">
                    <select
                      value={declaracion}
                      onChange={(e) => setDeclaracion(e.target.value as DeclaracionJurada)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    >
                      {DECLARACIONES_JURADAS.map((d) => (
                        <option key={d.value} value={d.value}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                {canSeeKey ? (
                  <Field
                    label="Clave de recojo"
                    hint="Generada automáticamente. Se guarda cifrada y se entrega al cliente solo cuando el cobro esté validado."
                  >
                    <input
                      value={pickupCode}
                      onChange={(e) => setPickupCode(e.target.value)}
                      inputMode="numeric"
                      maxLength={4}
                      className="w-32 rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
                    />
                    {keyErr && <p className="mt-1 text-xs text-red-600">{keyErr}</p>}
                  </Field>
                ) : (
                  <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                    La clave de recojo se genera sola y queda cifrada. Se entrega al cliente desde el
                    panel de pagos, cuando el cobro esté validado.
                  </p>
                )}

                <div className="flex items-center gap-3">
                  <button
                    onClick={fetchQuote}
                    disabled={!sessionReady || !agency}
                    className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-700 disabled:opacity-40"
                  >
                    Cotizar
                  </button>
                  {quote && <p className="text-xs text-slate-600">{quote}</p>}
                </div>

                {error && (
                  <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
                )}

                <p className="text-xs text-slate-400">
                  Esto crea una preguía <strong>real y cobrable</strong> en la cuenta de Shalom Pro.
                  No hay reintento automático: si la llamada se corta, el sistema va a buscar la guía
                  en Shalom antes de dar nada por perdido.
                </p>

                <div className="flex justify-end gap-2 pt-1">
                  <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-slate-600">
                    Cancelar
                  </button>
                  <button
                    onClick={submit}
                    disabled={!canSubmit}
                    className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                  >
                    {pending ? "Creando…" : "Crear guía"}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}
