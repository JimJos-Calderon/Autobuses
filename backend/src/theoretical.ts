import type { LiveArrival } from "@autobuses/shared";
import { sanitizeNullableText, sanitizeTitle } from "./sanitizer.js";

const STATIC_TIMETABLE_URLS = [
  "https://datos.vigo.org/data/transporte/horarios.json",
  "https://servizos.vigo.org/html/vigo/datos/transporte/horarios.json",
] as const;

const FETCH_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent": "BusVigo-BFF/1.0 (theoretical timetable fallback)",
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function listCandidates(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const root = asRecord(raw);
  if (!root) return [];
  const keys = ["horarios", "items", "data", "results", "times"];
  for (const key of keys) {
    const value = root[key];
    if (Array.isArray(value)) return value;
  }
  for (const key of Object.keys(root)) {
    const nested = asRecord(root[key]);
    if (!nested) continue;
    for (const nestedKey of keys) {
      const value = nested[nestedKey];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

function pickString(...vals: unknown[]): string | undefined {
  for (const value of vals) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function parseMinuteValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const match = value.match(/[0-9]+/);
    if (!match) return undefined;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function minutesUntilClock(timeHHmm: string, now = new Date()): number | null {
  const match = timeHHmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh > 23 || mm > 59) return null;

  const target = new Date(now);
  target.setHours(hh, mm, 0, 0);
  let diff = Math.round((target.getTime() - now.getTime()) / 60_000);
  if (diff < 0) {
    target.setDate(target.getDate() + 1);
    diff = Math.round((target.getTime() - now.getTime()) / 60_000);
  }
  return diff;
}

function timetableUrls(): string[] {
  const override = process.env.STATIC_TIMETABLE_URL?.trim();
  return override ? [override] : [...STATIC_TIMETABLE_URLS];
}

export async function fetchTheoreticalRaw(): Promise<unknown> {
  let lastError: Error | undefined;
  for (const url of timetableUrls()) {
    try {
      const res = await fetch(url, { headers: FETCH_HEADERS });
      if (!res.ok) {
        lastError = new Error(`Static timetable upstream ${url} -> ${res.status}`);
        continue;
      }
      return (await res.json()) as unknown;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error("No hay URL de horarios teoricos configurada");
}

function parseRowAsArrival(row: Record<string, unknown>, stopId: string): LiveArrival[] {
  const rowStop = pickString(
    row.stopId,
    row.stop_id,
    row.parada,
    row.idParada,
    row.codigoParada,
    row.cod_parada,
  );
  if (!rowStop || rowStop !== stopId) return [];

  const line = pickString(row.linea, row.line, row.lineId, row.idLinea, row.route);
  const destination = sanitizeNullableText(
    pickString(row.destino, row.destination, row.hacia, row.cabecera),
  );
  if (!line || !destination) return [];

  const directMinutes = parseMinuteValue(row.tiempo_minutos ?? row.minutos ?? row.wait);
  if (directMinutes !== undefined) {
    return [
      {
        linea: sanitizeTitle(line),
        destino: destination,
        tiempo_minutos: directMinutes,
        isTheoretical: true,
      },
    ];
  }

  const values = [row.hora, row.time, row.hhmm, row.horario, row.proxima, row.next];
  const arrivals: LiveArrival[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const mins = minutesUntilClock(value);
    if (mins === null) continue;
    arrivals.push({
      linea: sanitizeTitle(line),
      destino: destination,
      tiempo_minutos: mins,
      isTheoretical: true,
    });
  }
  return arrivals;
}

export function parseTheoreticalArrivals(raw: unknown, stopId: string): LiveArrival[] {
  const rows = listCandidates(raw);
  const out: LiveArrival[] = [];
  for (const item of rows) {
    const row = asRecord(item);
    if (!row) continue;
    out.push(...parseRowAsArrival(row, stopId));
  }
  out.sort((a, b) => a.tiempo_minutos - b.tiempo_minutos);
  return out.slice(0, 8);
}

export async function fetchTheoreticalArrivals(stopId: string): Promise<LiveArrival[]> {
  try {
    const raw = await fetchTheoreticalRaw();
    return parseTheoreticalArrivals(raw, stopId);
  } catch {
    return [];
  }
}
