import type { BusStop } from "@autobuses/shared";

/**
 * JSON de paradas Vitrasa publicado en Open Data del Concello.
 * Catálogo CKAN (grupo Movilidad): https://datos-ckan.vigo.org/group/transporte
 * Dataset «Paradas de Vitrasa»: recurso JSON → datos.vigo.org (mismo contenido que otras rutas legacy).
 */
const DEFAULT_PARADAS_URLS = [
  "https://datos.vigo.org/data/transporte/paradas.json",
  "https://servizos.vigo.org/html/vigo/datos/transporte/paradas.json",
] as const;

const FETCH_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent": "BusVigo-BFF/1.0 (Node; datos abertos Concello de Vigo)",
};

function paradasUrls(): string[] {
  const override = process.env.PARADAS_URL?.trim();
  if (override) return [override];
  return [...DEFAULT_PARADAS_URLS];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

/** Convierte la respuesta del ayuntamiento (array u objeto envolvente) en lista homogénea. */
export function extractParadasList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const o = asRecord(raw);
  if (!o) return [];
  const candidates = ["paradas", "features", "data", "items", "results"];
  for (const k of candidates) {
    const v = o[k];
    if (Array.isArray(v)) return v;
  }
  return [];
}

function pickString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

/** GeoJSON Feature o fila plana → BusStop */
export function itemToBusStop(item: unknown): BusStop | null {
  const o = asRecord(item);
  if (!o) return null;

  const props = asRecord(o.properties) ?? o;

  const id =
    pickString(
      props.id,
      props.codigo,
      props.codParada,
      props.codigoParada,
      o.id,
      o.codigo,
    ) ?? "";
  const name =
    pickString(
      props.name,
      props.nombre,
      props.title,
      props.descripcion,
      o.name,
      o.nombre,
      o.title,
    ) ?? "Sin nombre";

  let lat: number | undefined;
  let lon: number | undefined;

  const geom = asRecord(o.geometry);
  if (geom?.type === "Point" && Array.isArray(geom.coordinates)) {
    const [x, y] = geom.coordinates as number[];
    if (typeof x === "number" && typeof y === "number") {
      lon = x;
      lat = y;
    }
  }
  const flatLat = pickString(props.lat, props.latitude, o.lat, o.latitude);
  const flatLon = pickString(props.lon, props.lng, props.longitude, o.lon, o.longitude);
  if (flatLat && flatLon) {
    lat = Number(flatLat);
    lon = Number(flatLon);
  }

  if (!id) return null;

  const stop: BusStop = { id, name };
  if (lat !== undefined && lon !== undefined && Number.isFinite(lat) && Number.isFinite(lon)) {
    stop.lat = lat;
    stop.lon = lon;
  }
  return stop;
}

/** Descarga JSON desde la primera URL que responda 200. */
export async function fetchParadasJson(): Promise<unknown> {
  const urls = paradasUrls();
  let lastError: Error | undefined;
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: FETCH_HEADERS });
      if (!res.ok) {
        lastError = new Error(`Paradas upstream ${url} → ${res.status} ${res.statusText}`);
        continue;
      }
      return (await res.json()) as unknown;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error("No hay URLs de paradas configuradas");
}

export function jsonToBusStops(raw: unknown): BusStop[] {
  const list = extractParadasList(raw);
  const out: BusStop[] = [];
  for (const item of list) {
    const s = itemToBusStop(item);
    if (s) out.push(s);
  }
  return out;
}
