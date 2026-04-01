import fs from "node:fs/promises";
import path from "node:path";
import type { BusStop, LineGeometryFeatureCollection } from "@autobuses/shared";
import { BACKEND_PROCESSED_DIR } from "./paths.js";

const PROCESSED_DIR = BACKEND_PROCESSED_DIR;
export const STOP_LINE_INDEX_PATH = path.resolve(PROCESSED_DIR, "stop-lines-index.json");
export const ENRICHED_STOPS_PATH = path.resolve(PROCESSED_DIR, "stops.enriched.json");

const EARTH_RADIUS_M = 6_371_000;
const DEFAULT_STOP_LINK_THRESHOLD_M = 150;
const SIGNIFICANT_METADATA_GAP_MIN = 5;
const SIGNIFICANT_METADATA_GAP_RATIO = 0.25;

type LineDirection = "ida" | "vuelta";

export interface StopLineIndex {
  byStopId: Record<string, string[]>;
  byStopIdDetailed: Record<string, StopLineIndexEntry[]>;
  byLineDirection: Record<string, StopLineIndexEntry[]>;
  entries: StopLineIndexEntry[];
}

export interface StopLineIndexEntry {
  stopId: string;
  lineId: string;
  direction: LineDirection;
  sequence: number;
  distanceMeters: number;
  chainageMeters: number;
  featureId: string;
}

type RuntimeGeometry =
  | { type: "LineString"; coordinates: [number, number][] }
  | { type: "MultiLineString"; coordinates: [number, number][][] };

type RuntimeProperties = {
  id?: string;
  lineId?: string;
  direction?: string;
  idBusLine?: string;
};

type RuntimeFeature = {
  geometry: RuntimeGeometry;
  properties: RuntimeProperties;
};

type StopWithLines = BusStop & {
  lines?: string[];
};

type RuntimeFeatureMeta = {
  feature: RuntimeFeature;
  lineId: string;
  direction: LineDirection;
  featureId: string;
};

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

function normalizeId(value: string | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

function extractDirection(properties: RuntimeProperties): LineDirection {
  const normalized = (properties.direction ?? "").trim().toLowerCase();
  if (normalized === "vuelta") return "vuelta";
  if (normalized === "ida") return "ida";

  const rawId = normalizeId(properties.id);
  if (rawId.endsWith("_VUELTA")) return "vuelta";
  return "ida";
}

function extractLineId(properties: RuntimeProperties): string {
  const lineId = normalizeId(properties.lineId);
  if (lineId) return lineId;

  const idBusLine = normalizeId(properties.idBusLine);
  if (idBusLine) return idBusLine;

  const rawId = normalizeId(properties.id);
  if (rawId.endsWith("_IDA")) return rawId.slice(0, -4);
  if (rawId.endsWith("_VUELTA")) return rawId.slice(0, -7);
  return rawId;
}

function stopHasLineMetadata(stop: BusStop, lineId: string): boolean {
  const row = stop as StopWithLines;
  const normalizedLineId = normalizeId(lineId);
  return (row.lines ?? []).some((value) => normalizeId(value) === normalizedLineId);
}

function pushBestEntry(map: Map<string, StopLineIndexEntry>, entry: StopLineIndexEntry): void {
  const existing = map.get(entry.stopId);
  if (
    !existing ||
    entry.distanceMeters < existing.distanceMeters ||
    (entry.distanceMeters === existing.distanceMeters &&
      entry.chainageMeters < existing.chainageMeters)
  ) {
    map.set(entry.stopId, entry);
  }
}

function pointSegmentProjection(
  lat: number,
  lon: number,
  latA: number,
  lonA: number,
  latB: number,
  lonB: number,
): { distanceMeters: number; chainageMeters: number } {
  const x = lon;
  const y = lat;
  const x1 = lonA;
  const y1 = latA;
  const x2 = lonB;
  const y2 = latB;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) {
    return {
      distanceMeters: haversineMeters(lat, lon, latA, lonA),
      chainageMeters: 0,
    };
  }
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  const projLon = x1 + t * dx;
  const projLat = y1 + t * dy;
  return {
    distanceMeters: haversineMeters(lat, lon, projLat, projLon),
    chainageMeters: haversineMeters(latA, lonA, projLat, projLon),
  };
}

function projectStopOnFeature(
  stop: BusStop,
  feature: RuntimeFeature,
): Omit<StopLineIndexEntry, "sequence" | "lineId" | "direction" | "featureId"> | null {
  if (stop.lat === undefined || stop.lon === undefined) return null;

  const parts =
    feature.geometry.type === "MultiLineString"
      ? feature.geometry.coordinates
      : [feature.geometry.coordinates];

  let bestDistance = Number.POSITIVE_INFINITY;
  let bestChainage = 0;
  let accumulatedPartOffset = 0;

  for (const coordinates of parts) {
    let accumulatedSegmentOffset = 0;

    for (let i = 0; i < coordinates.length - 1; i += 1) {
      const [lonA, latA] = coordinates[i];
      const [lonB, latB] = coordinates[i + 1];
      const projection = pointSegmentProjection(stop.lat, stop.lon, latA, lonA, latB, lonB);
      if (projection.distanceMeters < bestDistance) {
        bestDistance = projection.distanceMeters;
        bestChainage = accumulatedPartOffset + accumulatedSegmentOffset + projection.chainageMeters;
      }
      accumulatedSegmentOffset += haversineMeters(latA, lonA, latB, lonB);
    }

    accumulatedPartOffset += accumulatedSegmentOffset;
  }

  if (!Number.isFinite(bestDistance)) return null;
  return {
    stopId: stop.id,
    distanceMeters: bestDistance,
    chainageMeters: bestChainage,
  };
}

export function buildStopLineIndex(
  stops: BusStop[],
  lines: LineGeometryFeatureCollection,
  thresholdMeters = DEFAULT_STOP_LINK_THRESHOLD_M,
): StopLineIndex {
  const byStopId: Record<string, string[]> = {};
  const byStopIdDetailed: Record<string, StopLineIndexEntry[]> = {};
  const byLineDirectionBuckets = new Map<string, StopLineIndexEntry[]>();
  const entries: StopLineIndexEntry[] = [];
  const featureMetas: RuntimeFeatureMeta[] = (lines.features as unknown as RuntimeFeature[])
    .map((feature) => {
      const lineId = extractLineId(feature.properties);
      if (!lineId) return null;
      const direction = extractDirection(feature.properties);
      const featureId = normalizeId(feature.properties.id) || `${lineId}_${direction}`;
      return { feature, lineId, direction, featureId };
    })
    .filter((value): value is RuntimeFeatureMeta => Boolean(value));
  const featuresByLineId = new Map<string, RuntimeFeatureMeta[]>();

  for (const stop of stops) {
    byStopId[stop.id] = [];
    byStopIdDetailed[stop.id] = [];
  }

  for (const featureMeta of featureMetas) {
    const bucket = featuresByLineId.get(featureMeta.lineId) ?? [];
    bucket.push(featureMeta);
    featuresByLineId.set(featureMeta.lineId, bucket);
  }

  for (const [lineId, directionalFeatures] of featuresByLineId.entries()) {
    const directionalMatches = new Map<string, Map<string, StopLineIndexEntry>>();
    const metadataAudit: Record<LineDirection, { totalStops: number; mappedStops: number }> = {
      ida: { totalStops: 0, mappedStops: 0 },
      vuelta: { totalStops: 0, mappedStops: 0 },
    };

    for (const stop of stops) {
      const projections = directionalFeatures
        .map((meta) => {
          const projected = projectStopOnFeature(stop, meta.feature);
          if (!projected) return null;
          return { ...meta, projected };
        })
        .filter(
          (
            value,
          ): value is RuntimeFeatureMeta & {
            projected: Omit<StopLineIndexEntry, "sequence" | "lineId" | "direction" | "featureId">;
          } => Boolean(value),
        );

      if (projections.length === 0) continue;

      const hasMetadata = stopHasLineMetadata(stop, lineId);
      const geoMatches = projections.filter((projection) => projection.projected.distanceMeters <= thresholdMeters);

      for (const projection of geoMatches) {
        const bucketKey = `${projection.lineId}:${projection.direction}`;
        const bucket = directionalMatches.get(bucketKey) ?? new Map<string, StopLineIndexEntry>();
        pushBestEntry(bucket, {
          ...projection.projected,
          lineId: projection.lineId,
          direction: projection.direction,
          sequence: 0,
          featureId: projection.featureId,
        });
        directionalMatches.set(bucketKey, bucket);

        if (hasMetadata) {
          metadataAudit[projection.direction].totalStops += 1;
          metadataAudit[projection.direction].mappedStops += 1;
        }
      }

      if (!hasMetadata || geoMatches.length > 0) continue;

      const nearest = projections
        .slice()
        .sort(
          (a, b) =>
            a.projected.distanceMeters - b.projected.distanceMeters ||
            a.projected.chainageMeters - b.projected.chainageMeters,
        )[0];

      const forcedBucketKey = `${nearest.lineId}:${nearest.direction}`;
      const forcedBucket =
        directionalMatches.get(forcedBucketKey) ?? new Map<string, StopLineIndexEntry>();
      pushBestEntry(forcedBucket, {
        ...nearest.projected,
        lineId: nearest.lineId,
        direction: nearest.direction,
        sequence: 0,
        featureId: nearest.featureId,
      });
      directionalMatches.set(forcedBucketKey, forcedBucket);
      metadataAudit[nearest.direction].totalStops += 1;
    }

    for (const direction of ["ida", "vuelta"] as const) {
      const bucketKey = `${lineId}:${direction}`;
      const matches = Array.from(directionalMatches.get(bucketKey)?.values() ?? []);
      const audit = metadataAudit[direction];

      console.log(
        `[DEBUG] Línea ${lineId} ${direction}: ${audit.totalStops} paradas encontradas en metadata vs ${audit.mappedStops} vinculadas geográficamente`,
      );

      const missingByGeometry = audit.totalStops - audit.mappedStops;
      if (
        missingByGeometry >= SIGNIFICANT_METADATA_GAP_MIN &&
        audit.totalStops > 0 &&
        missingByGeometry / audit.totalStops >= SIGNIFICANT_METADATA_GAP_RATIO
      ) {
        console.warn(
          `[WARN] Línea ${lineId} ${direction}: diferencia alta entre metadata y vinculación geográfica (${audit.totalStops} vs ${audit.mappedStops}). Se forzó inclusión para ${missingByGeometry} paradas.`,
        );
      }

      matches
        .sort((a, b) => {
          if (a.chainageMeters !== b.chainageMeters) return a.chainageMeters - b.chainageMeters;
          if (a.distanceMeters !== b.distanceMeters) return a.distanceMeters - b.distanceMeters;
          return a.stopId.localeCompare(b.stopId, "es-ES");
        })
        .forEach((entry, index) => {
          entry.sequence = index + 1;
        });

      if (matches.length === 0) continue;
      byLineDirectionBuckets.set(bucketKey, matches);
    }
  }

  const byLineDirection: Record<string, StopLineIndexEntry[]> = {};

  for (const [bucketKey, bucketEntries] of byLineDirectionBuckets.entries()) {
    const normalizedBucket = bucketEntries
      .slice()
      .sort((a, b) => a.sequence - b.sequence || a.stopId.localeCompare(b.stopId, "es-ES"));

    byLineDirection[bucketKey] = normalizedBucket;
    entries.push(...normalizedBucket);

    for (const entry of normalizedBucket) {
      byStopIdDetailed[entry.stopId].push(entry);
      byStopId[entry.stopId].push(entry.lineId);
    }
  }

  for (const stop of stops) {
    byStopId[stop.id] = Array.from(new Set(byStopId[stop.id])).sort((a, b) =>
      a.localeCompare(b, "es-ES"),
    );
    byStopIdDetailed[stop.id].sort((a, b) => {
      if (a.lineId !== b.lineId) return a.lineId.localeCompare(b.lineId, "es-ES");
      if (a.direction !== b.direction) return a.direction.localeCompare(b.direction, "es-ES");
      return a.sequence - b.sequence;
    });
  }

  entries.sort((a, b) => {
    if (a.lineId !== b.lineId) return a.lineId.localeCompare(b.lineId, "es-ES");
    if (a.direction !== b.direction) return a.direction.localeCompare(b.direction, "es-ES");
    return a.sequence - b.sequence;
  });

  return { byStopId, byStopIdDetailed, byLineDirection, entries };
}

export function enrichStopsWithLines(stops: BusStop[], index: StopLineIndex): BusStop[] {
  return stops.map((stop) => {
    const detailed = index.byStopIdDetailed[stop.id] ?? [];
    const lineRefs = detailed.map((entry) => ({
      lineId: entry.lineId,
      direction: entry.direction,
      sequence: entry.sequence,
      chainageMeters: entry.chainageMeters,
      distanceMeters: entry.distanceMeters,
      featureId: entry.featureId,
    }));
    const routes = detailed.map((entry) => ({
      lineId: entry.lineId,
      direction: entry.direction,
      sequence: entry.sequence,
    }));

    return {
      ...stop,
      lines: index.byStopId[stop.id] ?? [],
      routes,
      lineRefs,
      stopLines: lineRefs,
    } as BusStop;
  });
}

export function mergeStopsWithMetadata(
  stops: BusStop[],
  metadataStops: BusStop[] | null,
): BusStop[] {
  if (!metadataStops || metadataStops.length === 0) return stops;

  const metadataById = new Map(metadataStops.map((stop) => [stop.id, stop] as const));
  return stops.map((stop) => {
    const metadata = metadataById.get(stop.id);
    if (!metadata) return stop;

    const mergedLines = Array.from(
      new Set([...(stop.lines ?? []), ...(metadata.lines ?? [])].filter(Boolean)),
    ).sort((a, b) => a.localeCompare(b, "es-ES"));

    return {
      ...metadata,
      ...stop,
      lines: mergedLines,
    };
  });
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
    const parsed = JSON.parse(raw) as Partial<StopLineIndex>;
    if (!parsed?.byStopId || typeof parsed.byStopId !== "object") return null;

    const byStopIdDetailed =
      parsed.byStopIdDetailed && typeof parsed.byStopIdDetailed === "object"
        ? (parsed.byStopIdDetailed as Record<string, StopLineIndexEntry[]>)
        : {};
    const byLineDirection =
      parsed.byLineDirection && typeof parsed.byLineDirection === "object"
        ? (parsed.byLineDirection as Record<string, StopLineIndexEntry[]>)
        : {};
    const entries = Array.isArray(parsed.entries) ? (parsed.entries as StopLineIndexEntry[]) : [];

    return {
      byStopId: parsed.byStopId as Record<string, string[]>,
      byStopIdDetailed,
      byLineDirection,
      entries,
    };
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
