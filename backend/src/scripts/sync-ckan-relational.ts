import fs from "node:fs/promises";
import path from "node:path";
import axios from "axios";
import type { BusStop } from "@autobuses/shared";
import { BACKEND_PROCESSED_DIR } from "../paths.js";
import type { StopLineIndex, StopLineIndexEntry } from "../stop-lines.js";

type Direction = "ida" | "vuelta";
type Coordinate = [number, number];

type Geometry =
  | { type: "LineString"; coordinates: Coordinate[] }
  | { type: "MultiLineString"; coordinates: Coordinate[][] };

type LineFeature = {
  type: "Feature";
  properties: Record<string, unknown> & {
    id?: string;
    lineId?: string;
    idBusLine?: string;
    direction?: string;
    color?: string;
    name?: string;
    route_id?: string;
    linea?: string;
  };
  geometry: Geometry;
};

type LineCollection = {
  type: "FeatureCollection";
  features: LineFeature[];
};

type CkanStopRow = {
  id?: string | number;
  stop_id?: string | number;
  nombre?: string;
  lat?: number | string;
  lon?: number | string;
  lineas?: string;
};

type RouteRef = {
  lineId: string;
  direction: Direction;
  sequence: number;
  chainageMeters: number;
  distanceMeters: number;
  featureId: string;
};

type EnrichedStop = BusStop & {
  routes: Array<Pick<RouteRef, "lineId" | "direction" | "sequence">>;
  lineRefs: RouteRef[];
  stopLines: RouteRef[];
};

type Projection = {
  distanceMeters: number;
  chainageMeters: number;
  partIndex: number;
  segmentIndex: number;
};

type CandidateRoute = Omit<RouteRef, "sequence"> & {
  stopId: string;
  stopName: string;
  lat?: number;
  lon?: number;
};

type Metrics = {
  totalStops: number;
  assignedStops: number;
  routeAssignments: number;
  missingStops: number;
  snappedInsertions: number;
};

const PROCESSED_DIR = BACKEND_PROCESSED_DIR;
const STOPS_URL = "https://datos.vigo.org/data/transporte/paradas.json";
const LINES_URL = "https://datos.vigo.org/data/transporte/lineas.geojson";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const LINES_GEOJSON_PATH = path.resolve(PROCESSED_DIR, "lines.geojson");
const STOPS_ENRICHED_PATH = path.resolve(PROCESSED_DIR, "stops.enriched.json");
const STOP_LINES_INDEX_PATH = path.resolve(PROCESSED_DIR, "stop-lines-index.json");

const SNAP_INSERT_MIN_DISTANCE_M = 5;

function normalizeLineId(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/_(ida|vuelta)$/i, "")
    .toUpperCase();
}

function normalizeDirection(value: unknown): Direction | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "ida" || normalized === "vuelta") return normalized;
  return null;
}

function toNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function parseDeclaredLines(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return Array.from(
    new Set(
      value
        .split(/[;,|]/)
        .map((chunk) => normalizeLineId(chunk))
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b, "es-ES"));
}

function toRad(value: number): number {
  return (value * Math.PI) / 180;
}

function haversineMeters(a: Coordinate, b: Coordinate): number {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const earthRadiusM = 6_371_000;
  const aa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  return earthRadiusM * c;
}

function pointSegmentProjection(point: Coordinate, start: Coordinate, end: Coordinate): Projection {
  const [px, py] = point;
  const [x1, y1] = start;
  const [x2, y2] = end;
  const dx = x2 - x1;
  const dy = y2 - y1;

  if (dx === 0 && dy === 0) {
    return {
      distanceMeters: haversineMeters(point, start),
      chainageMeters: 0,
      partIndex: 0,
      segmentIndex: 0,
    };
  }

  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  const snapped: Coordinate = [x1 + t * dx, y1 + t * dy];

  return {
    distanceMeters: haversineMeters(point, snapped),
    chainageMeters: haversineMeters(start, snapped),
    partIndex: 0,
    segmentIndex: 0,
  };
}

function geometryParts(geometry: Geometry): Coordinate[][] {
  return geometry.type === "MultiLineString" ? geometry.coordinates : [geometry.coordinates];
}

function projectPointToGeometry(point: Coordinate, geometry: Geometry): Projection | null {
  let best: Projection | null = null;
  let offset = 0;

  geometryParts(geometry).forEach((part, partIndex) => {
    let partOffset = 0;
    for (let index = 0; index < part.length - 1; index += 1) {
      const projection = pointSegmentProjection(point, part[index], part[index + 1]);
      const candidate: Projection = {
        distanceMeters: projection.distanceMeters,
        chainageMeters: offset + partOffset + projection.chainageMeters,
        partIndex,
        segmentIndex: index,
      };
      if (
        !best ||
        candidate.distanceMeters < best.distanceMeters ||
        (candidate.distanceMeters === best.distanceMeters &&
          candidate.chainageMeters < best.chainageMeters)
      ) {
        best = candidate;
      }
      partOffset += haversineMeters(part[index], part[index + 1]);
    }
    offset += partOffset;
  });

  return best;
}

function buildFeatureLookup(lines: LineCollection): Map<string, LineFeature[]> {
  const out = new Map<string, LineFeature[]>();
  for (const feature of lines.features) {
    const lineId =
      normalizeLineId(feature.properties.lineId) ||
      normalizeLineId(feature.properties.idBusLine) ||
      normalizeLineId(feature.properties.id) ||
      normalizeLineId(feature.properties.linea);
    if (!lineId) continue;
    const bucket = out.get(lineId) ?? [];
    bucket.push(feature);
    out.set(lineId, bucket);
  }
  return out;
}

function featureDirection(feature: LineFeature): Direction {
  return normalizeDirection(feature.properties.direction) ?? "ida";
}

function featureId(feature: LineFeature): string {
  return (
    String(feature.properties.id ?? "").trim() ||
    `${normalizeLineId(feature.properties.lineId ?? feature.properties.idBusLine)}_${featureDirection(feature)}`
  );
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await axios.get<T>(url, {
    timeout: 30_000,
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  return response.data;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

function buildDirectionalCandidates(
  stop: BusStop,
  declaredLineId: string,
  currentIndex: StopLineIndex,
  processedLinesByLineId: Map<string, LineFeature[]>,
): CandidateRoute[] {
  const point: Coordinate | null =
    stop.lon !== undefined && stop.lat !== undefined ? [stop.lon, stop.lat] : null;
  const existing = (currentIndex.byStopIdDetailed[stop.id] ?? []).filter(
    (entry) => normalizeLineId(entry.lineId) === declaredLineId,
  );

  if (existing.length > 0) {
    return existing.map((entry) => ({
      stopId: stop.id,
      stopName: stop.name,
      lat: stop.lat,
      lon: stop.lon,
      lineId: declaredLineId,
      direction: entry.direction,
      chainageMeters: entry.chainageMeters,
      distanceMeters: entry.distanceMeters,
      featureId: entry.featureId,
    }));
  }

  const directionalFeatures = processedLinesByLineId.get(declaredLineId) ?? [];
  if (!point || directionalFeatures.length === 0) return [];

  const projections = directionalFeatures
    .map((feature) => {
      const projected = projectPointToGeometry(point, feature.geometry);
      if (!projected) return null;
      const candidate: CandidateRoute = {
        stopId: stop.id,
        stopName: stop.name,
        lat: stop.lat,
        lon: stop.lon,
        lineId: declaredLineId,
        direction: featureDirection(feature),
        chainageMeters: projected.chainageMeters,
        distanceMeters: projected.distanceMeters,
        featureId: featureId(feature),
      };
      return candidate;
    })
    .filter((value): value is CandidateRoute => value !== null);

  if (projections.length === 0) return [];
  projections.sort(
    (a, b) =>
      a.distanceMeters - b.distanceMeters || a.chainageMeters - b.chainageMeters,
  );
  return [projections[0]];
}

function assignSequences(candidates: CandidateRoute[]): Array<CandidateRoute & { sequence: number }> {
  const byLineDirection = new Map<string, CandidateRoute[]>();
  for (const candidate of candidates) {
    const key = `${candidate.lineId}:${candidate.direction}`;
    const bucket = byLineDirection.get(key) ?? [];
    bucket.push(candidate);
    byLineDirection.set(key, bucket);
  }

  const sequenced: Array<CandidateRoute & { sequence: number }> = [];
  for (const bucket of byLineDirection.values()) {
    bucket
      .sort(
        (a, b) =>
          a.chainageMeters - b.chainageMeters ||
          a.distanceMeters - b.distanceMeters ||
          a.stopId.localeCompare(b.stopId, "es-ES"),
      )
      .forEach((candidate, index) => {
        sequenced.push({
          stopId: candidate.stopId,
          stopName: candidate.stopName,
          lat: candidate.lat,
          lon: candidate.lon,
          lineId: candidate.lineId,
          direction: candidate.direction,
          sequence: index + 1,
          chainageMeters: candidate.chainageMeters,
          distanceMeters: candidate.distanceMeters,
          featureId: candidate.featureId,
        });
      });
  }

  return sequenced;
}

function buildStopLineIndexFromStops(stops: EnrichedStop[]): StopLineIndex {
  const byStopId: Record<string, string[]> = {};
  const byStopIdDetailed: Record<string, StopLineIndexEntry[]> = {};
  const byLineDirection: Record<string, StopLineIndexEntry[]> = {};
  const entries: StopLineIndexEntry[] = [];

  for (const stop of stops) {
    byStopId[stop.id] = Array.from(new Set(stop.routes.map((route) => route.lineId))).sort((a, b) =>
      a.localeCompare(b, "es-ES"),
    );
    byStopIdDetailed[stop.id] = stop.lineRefs.map((route) => ({
      stopId: stop.id,
      lineId: route.lineId,
      direction: route.direction,
      sequence: route.sequence,
      distanceMeters: route.distanceMeters,
      chainageMeters: route.chainageMeters,
      featureId: route.featureId,
    }));
    entries.push(...byStopIdDetailed[stop.id]);
  }

  for (const entry of entries) {
    const key = `${entry.lineId}:${entry.direction}`;
    (byLineDirection[key] ??= []).push(entry);
  }

  for (const key of Object.keys(byLineDirection)) {
    byLineDirection[key].sort((a, b) => a.sequence - b.sequence);
  }

  entries.sort((a, b) => {
    if (a.lineId !== b.lineId) return a.lineId.localeCompare(b.lineId, "es-ES");
    if (a.direction !== b.direction) return a.direction.localeCompare(b.direction, "es-ES");
    return a.sequence - b.sequence;
  });

  return { byStopId, byStopIdDetailed, byLineDirection, entries };
}

function nearestVertexDistanceMeters(point: Coordinate, geometry: Geometry): number {
  let best = Number.POSITIVE_INFINITY;
  for (const part of geometryParts(geometry)) {
    for (const coordinate of part) {
      best = Math.min(best, haversineMeters(point, coordinate));
    }
  }
  return best;
}

function insertStopPointIntoFeature(feature: LineFeature, stop: EnrichedStop): boolean {
  if (stop.lon === undefined || stop.lat === undefined) return false;
  const point: Coordinate = [stop.lon, stop.lat];
  if (nearestVertexDistanceMeters(point, feature.geometry) <= SNAP_INSERT_MIN_DISTANCE_M) {
    return false;
  }

  const projection = projectPointToGeometry(point, feature.geometry);
  if (!projection) return false;

  const parts = geometryParts(feature.geometry).map((part) => [...part]);
  const targetPart = parts[projection.partIndex];
  targetPart.splice(projection.segmentIndex + 1, 0, point);

  feature.geometry =
    feature.geometry.type === "MultiLineString"
      ? { type: "MultiLineString", coordinates: parts }
      : { type: "LineString", coordinates: parts[0] };

  return true;
}

async function main(): Promise<void> {
  await fs.mkdir(PROCESSED_DIR, { recursive: true });

  const previousStops = await readJsonFile<EnrichedStop[]>(STOPS_ENRICHED_PATH);
  const previousIndex = await readJsonFile<StopLineIndex>(STOP_LINES_INDEX_PATH);
  const processedLines = await readJsonFile<LineCollection>(LINES_GEOJSON_PATH);
  const ckanStops = await fetchJson<CkanStopRow[]>(STOPS_URL);
  const ckanLines = await fetchJson<{
    type: "FeatureCollection";
    features: Array<{ properties?: { linea?: string } }>;
  }>(LINES_URL);

  const processedLinesByLineId = buildFeatureLookup(processedLines);
  const ckanLineIds = new Set(
    ckanLines.features.map((feature) => normalizeLineId(feature.properties?.linea)).filter(Boolean),
  );

  const enrichedStops: EnrichedStop[] = [];
  const candidateRoutes: CandidateRoute[] = [];
  let assignedStops = 0;
  let routeAssignments = 0;
  let snappedInsertions = 0;
  const missingLineAssignments = new Set<string>();

  for (const row of ckanStops) {
    const stopId = String(row.id ?? row.stop_id ?? "").trim();
    if (!stopId) continue;

    const existingStop = previousStops.find((stop) => stop.id === stopId);
    const stop: BusStop = {
      id: stopId,
      name: String(row.nombre ?? existingStop?.name ?? `Parada ${stopId}`).trim(),
      lat: toNumber(row.lat) ?? existingStop?.lat,
      lon: toNumber(row.lon) ?? existingStop?.lon,
      lines: parseDeclaredLines(row.lineas),
    };

    const candidates = stop.lines?.flatMap((lineId) => {
      if (!ckanLineIds.has(lineId) && !processedLinesByLineId.has(lineId)) {
        missingLineAssignments.add(lineId);
      }
      return buildDirectionalCandidates(stop, lineId, previousIndex, processedLinesByLineId);
    }) ?? [];

    const uniqueByDirection = new Map<string, CandidateRoute>();
    for (const candidate of candidates) {
      const key = `${candidate.lineId}:${candidate.direction}`;
      const existing = uniqueByDirection.get(key);
      if (
        !existing ||
        candidate.distanceMeters < existing.distanceMeters ||
        (candidate.distanceMeters === existing.distanceMeters &&
          candidate.chainageMeters < existing.chainageMeters)
      ) {
        uniqueByDirection.set(key, candidate);
      }
    }

    enrichedStops.push({
      ...stop,
      lines: Array.from(new Set((stop.lines ?? []).map((lineId) => normalizeLineId(lineId)))).sort(
        (a, b) => a.localeCompare(b, "es-ES"),
      ),
      routes: [],
      lineRefs: [],
      stopLines: [],
    });

    candidateRoutes.push(...Array.from(uniqueByDirection.values()));
  }

  const routesByStopId = new Map<string, RouteRef[]>();
  for (const sequenced of assignSequences(candidateRoutes)) {
    const bucket = routesByStopId.get(sequenced.stopId) ?? [];
    bucket.push({
      lineId: sequenced.lineId,
      direction: sequenced.direction,
      sequence: sequenced.sequence,
      chainageMeters: sequenced.chainageMeters,
      distanceMeters: sequenced.distanceMeters,
      featureId: sequenced.featureId,
    });
    routesByStopId.set(sequenced.stopId, bucket);
  }

  for (const stop of enrichedStops) {
    const lineRefs = (routesByStopId.get(stop.id) ?? []).sort((a, b) => {
      if (a.lineId !== b.lineId) return a.lineId.localeCompare(b.lineId, "es-ES");
      if (a.direction !== b.direction) return a.direction.localeCompare(b.direction, "es-ES");
      return a.sequence - b.sequence;
    });
    const routes = lineRefs.map((route) => ({
      lineId: route.lineId,
      direction: route.direction,
      sequence: route.sequence,
    }));

    stop.lines = Array.from(new Set(routes.map((route) => route.lineId))).sort((a, b) =>
      a.localeCompare(b, "es-ES"),
    );
    stop.routes = routes;
    stop.lineRefs = lineRefs;
    stop.stopLines = lineRefs;

    if (routes.length > 0) assignedStops += 1;
    routeAssignments += routes.length;
  }

  const index = buildStopLineIndexFromStops(enrichedStops);

  for (const stop of enrichedStops) {
    for (const route of stop.lineRefs) {
      const feature = processedLines.features.find(
        (item) =>
          normalizeLineId(item.properties.lineId ?? item.properties.idBusLine) === route.lineId &&
          featureDirection(item) === route.direction,
      );
      if (!feature) continue;
      if (insertStopPointIntoFeature(feature, stop)) snappedInsertions += 1;
    }
  }

  await fs.writeFile(STOPS_ENRICHED_PATH, JSON.stringify(enrichedStops, null, 2), "utf8");
  await fs.writeFile(STOP_LINES_INDEX_PATH, JSON.stringify(index, null, 2), "utf8");
  await fs.writeFile(LINES_GEOJSON_PATH, JSON.stringify(processedLines, null, 2), "utf8");

  const metrics: Metrics = {
    totalStops: enrichedStops.length,
    assignedStops,
    routeAssignments,
    missingStops: enrichedStops.length - assignedStops,
    snappedInsertions,
  };

  console.log(
    `[sync-ckan-relational] CKAN paradas=${ckanStops.length} lineasCKAN=${ckanLineIds.size} featuresProcesadas=${processedLines.features.length}`,
  );
  console.log(
    `[sync-ckan-relational] paradas asignadas=${metrics.assignedStops}/${metrics.totalStops} routes=${metrics.routeAssignments} faltantes=${metrics.missingStops} snapInsertions=${metrics.snappedInsertions}`,
  );
  if (missingLineAssignments.size > 0) {
    console.warn(
      `[sync-ckan-relational] líneas declaradas en CKAN sin geometría procesada: ${Array.from(missingLineAssignments)
        .sort((a, b) => a.localeCompare(b, "es-ES"))
        .join(", ")}`,
    );
  }
  console.log(
    `[sync-ckan-relational] ejemplo parada=${enrichedStops[0]?.id ?? "-"} routes=${JSON.stringify(
      enrichedStops[0]?.routes ?? [],
    )}`,
  );
}

await main();
