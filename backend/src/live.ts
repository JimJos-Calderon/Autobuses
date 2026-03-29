import type { LiveArrival } from "@autobuses/shared";
import { sanitizeNullableText, sanitizeTitle } from "./sanitizer.js";
import { fetchTheoreticalArrivals } from "./theoretical.js";

const LIVE_PARADAS_URL =
  process.env.LIVE_PARADAS_URL?.trim() ||
  "https://servizos.vigo.org/html/vigo/datos/transporte/paradas.json";
const LIVE_TIMEOUT_MS = 5_000;
const LIVE_RETRIES = 2;

const FETCH_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent": "BusVigo-BFF/1.0 (Node; realtime proxy)",
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const m = value.match(/[0-9]+/);
    if (!m) return undefined;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function pickString(...vals: unknown[]): string | undefined {
  for (const value of vals) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function listCandidates(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const root = asRecord(raw);
  if (!root) return [];

  const direct = [
    "lineas",
    "lines",
    "buses",
    "estimaciones",
    "proximos",
    "items",
    "data",
    "results",
  ];

  for (const key of direct) {
    const value = root[key];
    if (Array.isArray(value)) return value;
  }

  for (const key of Object.keys(root)) {
    const value = root[key];
    if (Array.isArray(value)) return value;
    const nested = asRecord(value);
    if (!nested) continue;
    for (const nestedKey of direct) {
      const nestedVal = nested[nestedKey];
      if (Array.isArray(nestedVal)) return nestedVal;
    }
  }

  return [];
}

function normalizeStopId(value: string): string {
  return value.replace(/\D+/g, "");
}

function compactStopId(value: string): string {
  const numeric = normalizeStopId(value);
  if (!numeric) return value.trim();
  const compacted = numeric.replace(/^0+/, "");
  return compacted || "0";
}

function stopIdCandidates(stopId: string): string[] {
  const trimmed = stopId.trim();
  const numeric = normalizeStopId(trimmed);
  const compacted = compactStopId(trimmed);
  const set = new Set<string>([trimmed, compacted]);
  if (numeric) {
    set.add(numeric);
    set.add(numeric.padStart(4, "0"));
    set.add(numeric.padStart(5, "0"));
  }
  return Array.from(set).filter(Boolean);
}

function extractStopIdFromRow(row: Record<string, unknown>): string | undefined {
  const props = asRecord(row.properties);
  return pickString(
    row.id,
    row.stopId,
    row.stop_id,
    row.codigo,
    row.codParada,
    row.codigoParada,
    row.parada,
    row.idParada,
    row.id_parada,
    props?.id,
    props?.stopId,
    props?.stop_id,
    props?.codigo,
    props?.codParada,
    props?.codigoParada,
    props?.parada,
    props?.idParada,
    props?.id_parada,
  );
}

function findStopRow(raw: unknown, stopId: string): Record<string, unknown> | null {
  const rows = listCandidates(raw);
  if (rows.length === 0) return null;
  const expected = new Set(stopIdCandidates(stopId).map((id) => compactStopId(id)));

  for (const item of rows) {
    const row = asRecord(item);
    if (!row) continue;
    const found = extractStopIdFromRow(row);
    if (!found) continue;
    if (expected.has(compactStopId(found))) return row;
  }

  return null;
}

function findNestedArrivalArray(stopRow: Record<string, unknown>): unknown[] {
  const keys = [
    "lineas",
    "lines",
    "buses",
    "estimaciones",
    "proximos",
    "items",
    "data",
    "results",
    "arrivals",
    "pasos",
  ];

  for (const key of keys) {
    const value = stopRow[key];
    if (Array.isArray(value)) return value;
  }

  for (const key of Object.keys(stopRow)) {
    const nested = asRecord(stopRow[key]);
    if (!nested) continue;
    for (const nestedKey of keys) {
      const value = nested[nestedKey];
      if (Array.isArray(value)) return value;
    }
  }

  return [];
}

function itemToArrival(item: unknown): LiveArrival | null {
  const row = asRecord(item);
  if (!row) return null;

  const lineaRaw = pickString(
    row.linea,
    row.line,
    row.route,
    row.codigoLinea,
    row.idLinea,
    row.line_id,
  );
  const destinoRaw = sanitizeNullableText(
    pickString(row.destino, row.destination, row.cabecera, row.heading, row.hacia),
  );
  const minutos = parseNumber(
    row.tiempo_minutos ?? row.minutos ?? row.minutes ?? row.tiempo ?? row.wait ?? row.eta,
  );

  if (!lineaRaw || !destinoRaw || minutos === undefined) return null;

  return {
    linea: sanitizeTitle(lineaRaw),
    tiempo_minutos: minutos,
    destino: destinoRaw,
  };
}

function hasArrivalLikeFields(item: unknown): boolean {
  const row = asRecord(item);
  if (!row) return false;
  return Boolean(
    pickString(row.linea, row.line, row.route, row.codigoLinea, row.idLinea, row.line_id) &&
      pickString(row.destino, row.destination, row.cabecera, row.heading, row.hacia),
  );
}

function isAbortError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "AbortError";
}

async function fetchJsonWithTimeoutAndRetry(url: string): Promise<unknown> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= LIVE_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: FETCH_HEADERS,
        signal: controller.signal,
      });
      if (!res.ok) {
        lastError = new Error(`Live upstream ${url} -> ${res.status} ${res.statusText}`);
        continue;
      }
      const raw = (await res.json()) as unknown;
      const preview = JSON.stringify(raw);
      console.log(
        `[live/upstream] ok url=${url} attempt=${attempt} body=${preview.slice(0, 1200)}`,
      );
      return raw;
    } catch (e) {
      const asError = e instanceof Error ? e : new Error(String(e));
      if (isAbortError(e)) {
        lastError = new Error(`Timeout ${LIVE_TIMEOUT_MS}ms consultando ${url}`);
      } else {
        lastError = asError;
      }
      console.warn(
        `[live/upstream] fallo url=${url} attempt=${attempt} error=${lastError.message}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError ?? new Error("No se pudo consultar paradas.json de tiempo real");
}

function liveUrlsForStop(stopId: string): string[] {
  const candidates = stopIdCandidates(stopId);
  const urls: string[] = [];
  for (const candidate of candidates) {
    const encoded = encodeURIComponent(candidate);
    urls.push(`${LIVE_PARADAS_URL}?parada=${encoded}`);
    urls.push(`${LIVE_PARADAS_URL}?idParada=${encoded}`);
    urls.push(`${LIVE_PARADAS_URL}?id=${encoded}`);
  }
  urls.push(LIVE_PARADAS_URL);
  return Array.from(new Set(urls));
}

export async function fetchLiveRaw(stopId: string): Promise<unknown> {
  let lastError: Error | undefined;
  for (const url of liveUrlsForStop(stopId)) {
    try {
      return await fetchJsonWithTimeoutAndRetry(url);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("No se pudo consultar paradas.json de tiempo real");
}

export function parseLiveArrivals(raw: unknown): LiveArrival[] {
  const rows = listCandidates(raw);
  const out: LiveArrival[] = [];
  for (const row of rows) {
    const parsed = itemToArrival(row);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parseLiveArrivalsForStop(raw: unknown, stopId: string): LiveArrival[] {
  const stopRow = findStopRow(raw, stopId);
  if (stopRow) {
    const nestedRows = findNestedArrivalArray(stopRow);
    const fromNested = parseLiveArrivals(nestedRows);
    if (fromNested.length > 0) return fromNested;
  }

  const rows = listCandidates(raw);
  const directArrivals = rows.filter((row) => hasArrivalLikeFields(row));
  return parseLiveArrivals(directArrivals);
}

export async function fetchLiveArrivalsWithFallback(stopId: string): Promise<LiveArrival[]> {
  try {
    const raw = await fetchLiveRaw(stopId);
    const live = parseLiveArrivalsForStop(raw, stopId).sort(
      (a, b) => a.tiempo_minutos - b.tiempo_minutos,
    );
    if (live.length > 0) return live;
    return await fetchTheoreticalArrivals(stopId);
  } catch (liveError) {
    const theoretical = await fetchTheoreticalArrivals(stopId);
    if (theoretical.length > 0) return theoretical;
    throw liveError;
  }
}

export async function fetchLiveArrivalsSafe(stopId: string): Promise<{
  arrivals: LiveArrival[];
  isTheoretical: boolean;
}> {
  try {
    const arrivals = await fetchLiveArrivalsWithFallback(stopId);
    const isTheoretical =
      arrivals.length > 0 && arrivals.every((arrival) => arrival.isTheoretical === true);
    return { arrivals, isTheoretical };
  } catch {
    return { arrivals: [], isTheoretical: true };
  }
}
