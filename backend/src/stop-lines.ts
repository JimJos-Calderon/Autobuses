import fs from "node:fs/promises";
import path from "node:path";
import type { BusStop, LineGeometryFeatureCollection } from "@autobuses/shared";
import { BACKEND_PROCESSED_DIR } from "./paths.js";

const PROCESSED_DIR = BACKEND_PROCESSED_DIR;
export const STOP_LINE_INDEX_PATH = path.resolve(PROCESSED_DIR, "stop-lines-index.json");
export const ENRICHED_STOPS_PATH = path.resolve(PROCESSED_DIR, "stops.enriched.json");

const EARTH_RADIUS_M = 6_371_000;

export interface StopLineIndex {
  byStopId: Record<string, string[]>;
}

function toRad(value: number): number {
  return (value * Math.PI) / 180;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

function pointSegmentDistanceMeters(
  lat: number,
  lon: number,
  latA: number,
  lonA: number,
  latB: number,
  lonB: number,
): number {
  const x = lon;
  const y = lat;
  const x1 = lonA;
  const y1 = latA;
  const x2 = lonB;
  const y2 = latB;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return haversineMeters(lat, lon, latA, lonA);
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  const projLon = x1 + t * dx;
  const projLat = y1 + t * dy;
  return haversineMeters(lat, lon, projLat, projLon);
}

export function buildStopLineIndex(
  stops: BusStop[],
  lines: LineGeometryFeatureCollection,
  thresholdMeters = 110,
): StopLineIndex {
  const byStopId: Record<string, string[]> = {};
  for (const stop of stops) {
    if (stop.lat === undefined || stop.lon === undefined) {
      byStopId[stop.id] = [];
      continue;
    }
    const hitLines: string[] = [];
    for (const feature of lines.features) {
      const coordinates = feature.geometry.coordinates;
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < coordinates.length - 1; i += 1) {
        const [lonA, latA] = coordinates[i];
        const [lonB, latB] = coordinates[i + 1];
        const dist = pointSegmentDistanceMeters(stop.lat, stop.lon, latA, lonA, latB, lonB);
        if (dist < best) best = dist;
      }
      if (best <= thresholdMeters) hitLines.push(feature.properties.id.toUpperCase());
    }
    byStopId[stop.id] = Array.from(new Set(hitLines)).sort((a, b) => a.localeCompare(b, "es-ES"));
  }
  return { byStopId };
}

export function enrichStopsWithLines(stops: BusStop[], index: StopLineIndex): BusStop[] {
  return stops.map((stop) => ({
    ...stop,
    lines: index.byStopId[stop.id] ?? [],
  }));
}

export async function writeStopLineArtifacts(
  index: StopLineIndex,
  enrichedStops: BusStop[],
): Promise<void> {
  await fs.mkdir(PROCESSED_DIR, { recursive: true });
  await fs.writeFile(STOP_LINE_INDEX_PATH, JSON.stringify(index, null, 2), "utf8");
  await fs.writeFile(ENRICHED_STOPS_PATH, JSON.stringify(enrichedStops, null, 2), "utf8");
}

export async function readStopLineIndex(): Promise<StopLineIndex | null> {
  try {
    const raw = await fs.readFile(STOP_LINE_INDEX_PATH, "utf8");
    const parsed = JSON.parse(raw) as StopLineIndex;
    if (!parsed?.byStopId || typeof parsed.byStopId !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function readEnrichedStopsFile(): Promise<BusStop[] | null> {
  try {
    const raw = await fs.readFile(ENRICHED_STOPS_PATH, "utf8");
    const parsed = JSON.parse(raw) as BusStop[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
