import axios from "axios";
import fs from "node:fs/promises";
import path from "node:path";
import type { LineGeometryFeatureCollection } from "@autobuses/shared";
import { load } from "cheerio";
import { fetchParadasJson, jsonToBusStops } from "../paradas.js";
import { BACKEND_PROCESSED_DIR } from "../paths.js";
import {
  buildStopLineIndex,
  enrichStopsWithLines,
  mergeStopsWithMetadata,
  readEnrichedStopsFile,
  writeStopLineArtifacts,
} from "../stop-lines.js";

type Coordinate = [number, number];
type Direction = "ida" | "vuelta";

type Geometry =
  | { type: "LineString"; coordinates: Coordinate[] }
  | { type: "MultiLineString"; coordinates: Coordinate[][] };

interface GeoFeature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: Geometry;
}

interface GeoFeatureCollection {
  type: "FeatureCollection";
  features: GeoFeature[];
}

interface VitrasaLineIndexEntry {
  idBusLine: string;
  idBusSAE: string;
  descBusLine: string;
  color?: string;
}

interface VitrasaLineDetail {
  idBusLine?: string;
  idBusSAE?: string;
  descBusLine?: string;
  color?: string;
  outTrip?: unknown;
  backTrip?: unknown;
}

interface VitrasaAjaxResponse {
  nombreTrayecto?: string;
  trayectosResponse?: string;
  detalleLineaResponse?: string;
  lineasColoresResponse?: string;
}

interface ScrapeResult {
  code: string;
  pageId: string;
  direction: Direction;
  source: "official" | "fallback";
  feature: GeoFeature;
}

interface StopRecord {
  id?: string;
  lat?: number;
  lon?: number;
}

interface RouteMetrics {
  jumps: number;
  featuresWithJumps: number;
  maxJumpMeters: number;
}

const LIST_URL = "https://www.vitrasa.es/lineas-y-horarios/todas-las-lineas";
const DETAIL_URL =
  "https://www.vitrasa.es/detalle-linea?p_p_id=adoLinea_AdoLineaFechaPortlet_INSTANCE_i5E3I7u6Bfu4&p_p_lifecycle=2&p_p_state=normal&p_p_mode=view&p_p_cacheability=cacheLevelPage&_adoLinea_AdoLineaFechaPortlet_INSTANCE_i5E3I7u6Bfu4_cmd=getTrayectosIda";
const DETAIL_REFERER = "https://www.vitrasa.es/detalle-linea";
const LINES_GEOJSON_PATH = path.resolve(BACKEND_PROCESSED_DIR, "lines.geojson");
const STOPS_ENRICHED_PATH = path.resolve(BACKEND_PROCESSED_DIR, "stops.enriched.json");
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const NEXT_NEIGHBOR_MAX_METERS = 200;
const SEGMENT_BREAK_METERS = 300;
const OUTLIER_NEIGHBOR_METERS = 500;
const DIRECTIONS: Direction[] = ["ida", "vuelta"];

function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeId(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeDirection(value: unknown): Direction | null {
  const normalized = toText(value).trim().toLowerCase();
  if (normalized === "ida" || normalized === "vuelta") return normalized;
  return null;
}

function buildDirectionalId(code: string, direction: Direction): string {
  return `${code}_${direction}`;
}

function extractBaseLineId(properties: Record<string, unknown>): string {
  const lineId = normalizeId(toText(properties.lineId));
  if (lineId) return lineId;

  const rawId = normalizeId(toText(properties.id));
  if (!rawId) return "";
  if (rawId.endsWith("_IDA")) return rawId.slice(0, -4);
  if (rawId.endsWith("_VUELTA")) return rawId.slice(0, -7);
  return rawId;
}

function parseJsonLineas(html: string): VitrasaLineIndexEntry[] {
  const $ = load(html);
  const scriptText = $("script")
    .toArray()
    .map((element) => $(element).html() ?? "")
    .find((text) => text.includes("const jsonLineas ="));

  if (!scriptText) {
    throw new Error("No se pudo encontrar el bloque jsonLineas en la web de Vitrasa");
  }

  const match = scriptText.match(/const jsonLineas = (\[[\s\S]*?\]);/);
  if (!match) {
    throw new Error("No se pudo extraer el array jsonLineas desde el script de Vitrasa");
  }

  const parsed = JSON.parse(match[1]) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("jsonLineas no es un array válido");
  }

  return parsed.map((entry) => {
    const row = entry as Record<string, unknown>;
    return {
      idBusLine: normalizeId(toText(row.idBusLine)),
      idBusSAE: normalizeId(toText(row.idBusSAE)),
      descBusLine: toText(row.descBusLine),
      color: typeof row.color === "string" ? row.color : undefined,
    };
  });
}

function parseMaybeJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

function toCoordinate(value: unknown): Coordinate | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lon = Number(value[0]);
  const lat = Number(value[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return [lon, lat];
}

function coordinateKey([lon, lat]: Coordinate): string {
  return `${lon.toFixed(6)},${lat.toFixed(6)}`;
}

function countCoordinates(geometry: Geometry): number {
  if (geometry.type === "LineString") return geometry.coordinates.length;
  return geometry.coordinates.reduce((sum, segment) => sum + segment.length, 0);
}

function flattenGeometryPoints(geometry: Geometry): Coordinate[] {
  return geometry.type === "LineString" ? [...geometry.coordinates] : geometry.coordinates.flat();
}

function dedupeCoordinates(points: Coordinate[]): Coordinate[] {
  const seen = new Set<string>();
  const out: Coordinate[] = [];
  for (const point of points) {
    const key = coordinateKey(point);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(point);
  }
  return out;
}

function pickRouteFeature(collection: unknown): GeoFeature | null {
  const parsed = parseMaybeJson<{ type?: string; features?: unknown[] }>(collection);
  if (!parsed || parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features)) {
    return null;
  }

  const features = parsed.features
    .map((item) => item as Record<string, unknown>)
    .filter((feature) => feature?.type === "Feature" && feature.geometry && feature.properties);

  const routeCandidates = features
    .filter((feature) => {
      const geometry = feature.geometry as Record<string, unknown>;
      return geometry.type === "LineString" || geometry.type === "MultiLineString";
    })
    .map((feature) => {
      const geometry = feature.geometry as Record<string, unknown>;
      const normalizedGeometry =
        geometry.type === "LineString"
          ? {
              type: "LineString" as const,
              coordinates: (geometry.coordinates as unknown[])
                .map((coordinate) => toCoordinate(coordinate))
                .filter((coordinate): coordinate is Coordinate => Boolean(coordinate)),
            }
          : {
              type: "MultiLineString" as const,
              coordinates: (geometry.coordinates as unknown[])
                .map((segment) =>
                  Array.isArray(segment)
                    ? segment
                        .map((coordinate) => toCoordinate(coordinate))
                        .filter((coordinate): coordinate is Coordinate => Boolean(coordinate))
                    : [],
                )
                .filter((segment) => segment.length > 0),
            };

      return {
        feature,
        score: countCoordinates(normalizedGeometry),
        geometry: normalizedGeometry,
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  if (routeCandidates.length === 0) return null;

  const winner = routeCandidates[0];
  return {
    type: "Feature",
    properties: (winner.feature.properties as Record<string, unknown>) ?? {},
    geometry: winner.geometry,
  };
}

function inferRouteName(detail: VitrasaLineDetail, fallbackCode: string): string {
  if (typeof detail.descBusLine === "string" && detail.descBusLine.trim()) {
    return detail.descBusLine.trim();
  }
  if (typeof detail.idBusSAE === "string" && detail.idBusSAE.trim()) {
    return detail.idBusSAE.trim().toUpperCase();
  }
  return fallbackCode;
}

function normalizeRouteFeature(
  feature: GeoFeature,
  code: string,
  detail: VitrasaLineDetail,
  entry: VitrasaLineIndexEntry,
  direction: Direction,
): GeoFeature {
  const properties = {
    ...(feature.properties ?? {}),
    id: buildDirectionalId(code, direction),
    lineId: code,
    direction,
    name: inferRouteName(detail, code),
  } as Record<string, unknown>;

  if (entry.color) {
    properties.color = entry.color;
  }

  return {
    ...feature,
    properties,
  };
}

function toFeatureCollection(raw: unknown): GeoFeatureCollection | null {
  const parsed = parseMaybeJson<{ type?: string; features?: unknown[] }>(raw);
  if (!parsed || parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features)) {
    return null;
  }

  const features: GeoFeature[] = [];
  for (const item of parsed.features) {
    const feature = item as Record<string, unknown>;
    if (feature?.type !== "Feature") continue;
    const geometry = feature.geometry as Record<string, unknown> | undefined;
    if (!geometry) continue;
    if (geometry.type !== "LineString" && geometry.type !== "MultiLineString") continue;

    const normalizedGeometry: Geometry =
      geometry.type === "LineString"
        ? {
            type: "LineString",
            coordinates: (geometry.coordinates as unknown[])
              .map((coordinate) => toCoordinate(coordinate))
              .filter((coordinate): coordinate is Coordinate => Boolean(coordinate)),
          }
        : {
            type: "MultiLineString",
            coordinates: (geometry.coordinates as unknown[])
              .map((segment) =>
                Array.isArray(segment)
                  ? segment
                      .map((coordinate) => toCoordinate(coordinate))
                      .filter((coordinate): coordinate is Coordinate => Boolean(coordinate))
                  : [],
              )
              .filter((segment) => segment.length > 0),
          };

    if (countCoordinates(normalizedGeometry) === 0) continue;

    features.push({
      type: "Feature",
      properties: (feature.properties as Record<string, unknown>) ?? {},
      geometry: normalizedGeometry,
    });
  }

  return { type: "FeatureCollection", features };
}

function cloneGeometry(geometry: Geometry): Geometry {
  return geometry.type === "LineString"
    ? { type: "LineString", coordinates: geometry.coordinates.map(([lon, lat]) => [lon, lat]) }
    : {
        type: "MultiLineString",
        coordinates: geometry.coordinates.map((segment) => segment.map(([lon, lat]) => [lon, lat])),
      };
}

function toLatLonPairs(geometry: Geometry): Coordinate[][] {
  return geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const earthRadiusMeters = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function countJumpsInCoordinates(parts: Coordinate[][], jumpThresholdMeters: number): RouteMetrics {
  let jumps = 0;
  let maxJumpMeters = 0;
  let featuresWithJumps = 0;

  for (const coordinates of parts) {
    let partJumpCount = 0;
    for (let i = 0; i < coordinates.length - 1; i += 1) {
      const [lonA, latA] = coordinates[i];
      const [lonB, latB] = coordinates[i + 1];
      const dist = haversineMeters(latA, lonA, latB, lonB);
      if (dist > jumpThresholdMeters) {
        jumps += 1;
        partJumpCount += 1;
        if (dist > maxJumpMeters) maxJumpMeters = dist;
      }
    }
    if (partJumpCount > 0) {
      featuresWithJumps += 1;
    }
  }

  return { jumps, featuresWithJumps, maxJumpMeters };
}

function measureNoise(geojson: GeoFeatureCollection): RouteMetrics {
  let jumps = 0;
  let featuresWithJumps = 0;
  let maxJumpMeters = 0;

  for (const feature of geojson.features) {
    const measured = countJumpsInCoordinates(toLatLonPairs(feature.geometry), SEGMENT_BREAK_METERS);
    jumps += measured.jumps;
    featuresWithJumps += measured.featuresWithJumps > 0 ? 1 : 0;
    if (measured.maxJumpMeters > maxJumpMeters) {
      maxJumpMeters = measured.maxJumpMeters;
    }
  }

  return { jumps, featuresWithJumps, maxJumpMeters };
}

function buildFallbackFeature(
  fallbackByDirection: Map<string, GeoFeature>,
  fallbackByCode: Map<string, GeoFeature>,
  code: string,
  direction: Direction,
  entry: VitrasaLineIndexEntry,
): GeoFeature | null {
  const directionalFallback = fallbackByDirection.get(`${code}:${direction}`);
  const genericFallback = fallbackByCode.get(code);
  const source = directionalFallback ?? genericFallback;
  if (!source) return null;

  return {
    ...source,
    geometry: cloneGeometry(source.geometry),
    properties: {
      ...(source.properties ?? {}),
      id: buildDirectionalId(code, direction),
      lineId: code,
      direction,
      name: inferRouteName({ idBusSAE: code, descBusLine: entry.descBusLine }, code),
    },
  };
}

async function fetchLineIndex(): Promise<VitrasaLineIndexEntry[]> {
  const response = await axios.get<string>(LIST_URL, {
    timeout: 45_000,
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": USER_AGENT,
    },
  });

  return parseJsonLineas(response.data);
}

async function fetchLineDetail(pageId: string): Promise<VitrasaLineDetail | null> {
  const response = await axios.post<VitrasaAjaxResponse>(
    DETAIL_URL,
    new URLSearchParams({
      _adoLinea_AdoLineaFechaPortlet_INSTANCE_i5E3I7u6Bfu4_idBusLine: pageId,
    }),
    {
      timeout: 45_000,
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": USER_AGENT,
        Origin: "https://www.vitrasa.es",
        Referer: DETAIL_REFERER,
        "X-Requested-With": "XMLHttpRequest",
      },
    },
  );

  return parseMaybeJson<VitrasaLineDetail>(response.data.detalleLineaResponse);
}

async function readGeoJsonFile(filePath: string): Promise<GeoFeatureCollection | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return toFeatureCollection(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

async function readStopsIndex(): Promise<Map<string, Coordinate>> {
  try {
    const raw = await fs.readFile(STOPS_ENRICHED_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Map();

    const out = new Map<string, Coordinate>();
    for (const item of parsed) {
      const row = item as StopRecord;
      if (typeof row.id !== "string") continue;
      if (!Number.isFinite(row.lon) || !Number.isFinite(row.lat)) continue;
      out.set(normalizeId(row.id), [Number(row.lon), Number(row.lat)]);
    }
    return out;
  } catch {
    return new Map();
  }
}

function filterOutlierPoints(points: Coordinate[]): Coordinate[] {
  if (points.length <= 2) return [...points];

  return points.filter((point, index) => {
    for (let i = 0; i < points.length; i += 1) {
      if (i === index) continue;
      const candidate = points[i];
      const distance = haversineMeters(point[1], point[0], candidate[1], candidate[0]);
      if (distance <= OUTLIER_NEIGHBOR_METERS) {
        return true;
      }
    }
    return false;
  });
}

function pickStartIndex(points: Coordinate[], stopCoord?: Coordinate): number {
  if (points.length === 0) return -1;

  if (stopCoord) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < points.length; i += 1) {
      const distance = haversineMeters(points[i][1], points[i][0], stopCoord[1], stopCoord[0]);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  return points.reduce((bestIndex, point, index) => {
    const current = points[bestIndex];
    if (point[0] < current[0]) return index;
    if (point[0] === current[0] && point[1] < current[1]) return index;
    return bestIndex;
  }, 0);
}

function findNearestUnvisited(
  current: Coordinate,
  points: Coordinate[],
  visited: Set<number>,
): { index: number; distanceMeters: number } | null {
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < points.length; i += 1) {
    if (visited.has(i)) continue;
    const distance = haversineMeters(current[1], current[0], points[i][1], points[i][0]);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  return bestIndex >= 0 ? { index: bestIndex, distanceMeters: bestDistance } : null;
}

function reorderGeometryByNearestNeighbor(geometry: Geometry, stopCoord?: Coordinate): Geometry {
  const points = filterOutlierPoints(dedupeCoordinates(flattenGeometryPoints(geometry)));

  if (points.length < 2) {
    return { type: "LineString", coordinates: [...points] };
  }

  const visited = new Set<number>();
  const parts: Coordinate[][] = [];
  let nextSeedIndex = pickStartIndex(points, stopCoord);

  while (nextSeedIndex >= 0 && visited.size < points.length) {
    if (visited.has(nextSeedIndex)) {
      const nextUnvisited = points.findIndex((_, index) => !visited.has(index));
      nextSeedIndex = nextUnvisited;
      if (nextSeedIndex < 0) break;
    }

    visited.add(nextSeedIndex);
    const segment: Coordinate[] = [points[nextSeedIndex]];
    let currentPoint = points[nextSeedIndex];

    while (visited.size < points.length) {
      const nearest = findNearestUnvisited(currentPoint, points, visited);
      if (!nearest) break;
      if (nearest.distanceMeters > NEXT_NEIGHBOR_MAX_METERS) break;

      visited.add(nearest.index);
      currentPoint = points[nearest.index];
      segment.push(currentPoint);
    }

    if (segment.length >= 2) {
      parts.push(segment);
    }

    let nextCandidate: { index: number; distanceMeters: number } | null = null;
    if (visited.size < points.length) {
      nextCandidate = findNearestUnvisited(currentPoint, points, visited);
    }

    if (nextCandidate && nextCandidate.distanceMeters <= SEGMENT_BREAK_METERS) {
      nextSeedIndex = nextCandidate.index;
      continue;
    }

    if (visited.size >= points.length) break;

    const remaining = points
      .map((point, index) => ({ point, index }))
      .filter(({ index }) => !visited.has(index));

    if (remaining.length === 0) break;

    if (stopCoord) {
      remaining.sort(
        (a, b) =>
          haversineMeters(a.point[1], a.point[0], stopCoord[1], stopCoord[0]) -
          haversineMeters(b.point[1], b.point[0], stopCoord[1], stopCoord[0]),
      );
      nextSeedIndex = remaining[0].index;
      continue;
    }

    remaining.sort((a, b) => {
      if (a.point[0] !== b.point[0]) return a.point[0] - b.point[0];
      return a.point[1] - b.point[1];
    });
    nextSeedIndex = remaining[0].index;
  }

  if (parts.length === 0) {
    const fallbackSegment = points.length >= 2 ? [points] : [];
    return fallbackSegment.length === 1
      ? { type: "LineString", coordinates: fallbackSegment[0] }
      : { type: "MultiLineString", coordinates: fallbackSegment };
  }

  return parts.length === 1
    ? { type: "LineString", coordinates: parts[0] }
    : { type: "MultiLineString", coordinates: parts };
}

async function main(): Promise<void> {
  const beforeGeo = (await readGeoJsonFile(LINES_GEOJSON_PATH)) ?? {
    type: "FeatureCollection",
    features: [],
  };
  const beforeNoise = measureNoise(beforeGeo);
  const stopsIndex = await readStopsIndex();

  const index = await fetchLineIndex();
  const fallbackByDirection = new Map<string, GeoFeature>();
  const fallbackByCode = new Map<string, GeoFeature>();

  for (const feature of beforeGeo.features) {
    const properties = feature.properties ?? {};
    const baseCode = extractBaseLineId(properties);
    if (!baseCode) continue;

    const direction = normalizeDirection(properties.direction);
    if (direction) {
      fallbackByDirection.set(`${baseCode}:${direction}`, feature);
    }

    if (!fallbackByCode.has(baseCode)) {
      fallbackByCode.set(baseCode, feature);
    }
  }

  const results: ScrapeResult[] = [];
  const fallbackIds: string[] = [];
  const missingOfficialIds: string[] = [];
  const featureCountByDirection: Record<Direction, number> = { ida: 0, vuelta: 0 };

  for (const entry of index) {
    const code = normalizeId(entry.idBusSAE);
    const pageId = normalizeId(entry.idBusLine);
    try {
      const detail = await fetchLineDetail(pageId);
      const parsed = parseMaybeJson<VitrasaLineDetail>(detail);
      const directionalRoutes: Record<Direction, GeoFeature | null> = {
        ida: pickRouteFeature(parsed?.outTrip),
        vuelta: pickRouteFeature(parsed?.backTrip),
      };

      for (const direction of DIRECTIONS) {
        const route = directionalRoutes[direction];
        if (route) {
          const normalized = normalizeRouteFeature(route, code, parsed ?? {}, entry, direction);
          const stopId = normalizeId(toText(normalized.properties.idBusStop));
          const stopCoord = stopId ? stopsIndex.get(stopId) : undefined;
          const beforeLineNoise = countJumpsInCoordinates(
            toLatLonPairs(normalized.geometry),
            SEGMENT_BREAK_METERS,
          );
          const reorderedGeometry = reorderGeometryByNearestNeighbor(normalized.geometry, stopCoord);
          const afterLineNoise = countJumpsInCoordinates(
            toLatLonPairs(reorderedGeometry),
            SEGMENT_BREAK_METERS,
          );

          console.log(
            `Línea ${buildDirectionalId(code, direction)}: Antes ${beforeLineNoise.jumps} saltos, Después ${afterLineNoise.jumps} saltos`,
          );

          results.push({
            code,
            pageId,
            direction,
            source: "official",
            feature: {
              ...normalized,
              geometry: reorderedGeometry,
            },
          });
          featureCountByDirection[direction] += 1;
          continue;
        }

        const fallback = buildFallbackFeature(fallbackByDirection, fallbackByCode, code, direction, entry);
        if (!fallback) {
          throw new Error(
            `No hay geometría ${direction} oficial ni fallback local para ${code} (pageId ${pageId}).`,
          );
        }

        fallbackIds.push(buildDirectionalId(code, direction));
        if (!missingOfficialIds.includes(pageId)) {
          missingOfficialIds.push(pageId);
        }
        const fallbackNoise = countJumpsInCoordinates(
          toLatLonPairs(fallback.geometry),
          SEGMENT_BREAK_METERS,
        );
        console.log(
          `Línea ${buildDirectionalId(code, direction)}: Antes ${fallbackNoise.jumps} saltos, Después ${fallbackNoise.jumps} saltos`,
        );

        results.push({
          code,
          pageId,
          direction,
          source: "fallback",
          feature: fallback,
        });
        featureCountByDirection[direction] += 1;
        console.warn(
          `[fallback] ${buildDirectionalId(code, direction)} (${pageId}) -> usando geometría local porque la oficial ${direction} falló.`,
        );
      }
    } catch (error) {
      if (!missingOfficialIds.includes(pageId)) {
        missingOfficialIds.push(pageId);
      }
      for (const direction of DIRECTIONS) {
        const fallback = buildFallbackFeature(fallbackByDirection, fallbackByCode, code, direction, entry);
        if (!fallback) {
          throw new Error(`No hay geometría oficial ni fallback local para ${code} (${direction}, pageId ${pageId}).`);
        }

        fallbackIds.push(buildDirectionalId(code, direction));
        const fallbackNoise = countJumpsInCoordinates(
          toLatLonPairs(fallback.geometry),
          SEGMENT_BREAK_METERS,
        );
        console.log(
          `Línea ${buildDirectionalId(code, direction)}: Antes ${fallbackNoise.jumps} saltos, Después ${fallbackNoise.jumps} saltos`,
        );

        results.push({
          code,
          pageId,
          direction,
          source: "fallback",
          feature: fallback,
        });
        featureCountByDirection[direction] += 1;
      }

      console.warn(
        `[fallback] ${code} (${pageId}) -> usando geometría local para ambos sentidos porque la oficial falló: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const finalGeo: GeoFeatureCollection = {
    type: "FeatureCollection",
    features: results.map((row) => row.feature),
  };

  if (finalGeo.features.length !== index.length * DIRECTIONS.length) {
    throw new Error(
      `Salida inválida: se esperaban ${index.length * DIRECTIONS.length} features y se construyeron ${finalGeo.features.length}.`,
    );
  }

  await fs.mkdir(path.dirname(LINES_GEOJSON_PATH), { recursive: true });
  await fs.writeFile(LINES_GEOJSON_PATH, JSON.stringify(finalGeo, null, 2), "utf8");

  const rawStops = await fetchParadasJson();
  const freshStops = jsonToBusStops(rawStops);
  const metadataStops = await readEnrichedStopsFile();
  const stops = mergeStopsWithMetadata(freshStops, metadataStops);
  const stopLineIndex = buildStopLineIndex(
    stops,
    finalGeo as unknown as LineGeometryFeatureCollection,
    150,
  );
  const enrichedStops = enrichStopsWithLines(stops, stopLineIndex);
  await writeStopLineArtifacts(stopLineIndex, enrichedStops);

  const afterNoise = measureNoise(finalGeo);
  const officialCount = results.filter((item) => item.source === "official").length;

  console.log(`[scrape-vitrasa-routes] líneas detectadas en listado: ${index.length}`);
  console.log(`[scrape-vitrasa-routes] features generadas: ${finalGeo.features.length}`);
  console.log(`[scrape-vitrasa-routes] oficiales: ${officialCount}`);
  console.log(`[scrape-vitrasa-routes] fallback local: ${fallbackIds.length}`);
  console.log(
    `[scrape-vitrasa-routes] features por dirección: ida=${featureCountByDirection.ida}, vuelta=${featureCountByDirection.vuelta}`,
  );
  console.log(
    `[scrape-vitrasa-routes] ids con fallback: ${fallbackIds.length > 0 ? fallbackIds.join(", ") : "ninguno"}`,
  );
  console.log(
    `[scrape-vitrasa-routes] pageIds sin geometría oficial: ${missingOfficialIds.length > 0 ? missingOfficialIds.join(", ") : "ninguno"}`,
  );
  console.log(
    `[scrape-vitrasa-routes] stop-lines-index actualizado: entradas=${stopLineIndex.entries.length}, paradas=${Object.keys(stopLineIndex.byStopId).length}`,
  );
  const sampleDirectional = stopLineIndex.byLineDirection["C1:ida"]?.slice(0, 3) ?? [];
  if (sampleDirectional.length > 0) {
    console.log(
      `[scrape-vitrasa-routes] ejemplo C1:ida -> ${sampleDirectional
        .map((entry) => `${entry.stopId}#${entry.sequence}`)
        .join(", ")}`,
    );
  }
  console.log(
    `[noise] antes -> jumps>${SEGMENT_BREAK_METERS}m=${beforeNoise.jumps}, features_con_saltos=${beforeNoise.featuresWithJumps}, max_jump=${beforeNoise.maxJumpMeters.toFixed(1)}m`,
  );
  console.log(
    `[noise] despues -> jumps>${SEGMENT_BREAK_METERS}m=${afterNoise.jumps}, features_con_saltos=${afterNoise.featuresWithJumps}, max_jump=${afterNoise.maxJumpMeters.toFixed(1)}m`,
  );
  console.log(`[scrape-vitrasa-routes] lines.geojson sobrescrito en ${LINES_GEOJSON_PATH}`);
}

await main();
