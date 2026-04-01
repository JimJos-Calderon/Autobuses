import fs from "node:fs/promises";
import path from "node:path";
import cleanCoords from "@turf/clean-coords";
import simplify from "@turf/simplify";
import truncate from "@turf/truncate";
import type { LineGeometryFeature, LineGeometryFeatureCollection } from "@autobuses/shared";
import { haversineMeters } from "../geo.js";
import { BACKEND_LINES_DIR, BACKEND_PROCESSED_DIR } from "../paths.js";
import { fetchParadasJson, jsonToBusStops } from "../paradas.js";
import { sanitizeTitle } from "../sanitizer.js";
import {
  buildStopLineIndex,
  enrichStopsWithLines,
  mergeStopsWithMetadata,
  readEnrichedStopsFile,
  writeStopLineArtifacts,
} from "../stop-lines.js";

type Coordinate = [number, number];

type ParsedSegment = {
  id: string;
  name: string;
  destination?: string;
  coordinates: Coordinate[];
};

type StitchedLine = {
  id: string;
  name: string;
  destination?: string;
  parts: Coordinate[][];
  totalSegments: number;
  stitchedSegments: number;
};

type MatchSide = "head" | "tail";

type MatchResult = {
  distanceMeters: number;
  remainingIndex: number;
  side: MatchSide;
  coordinates: Coordinate[];
};

const LINES_GEOJSON_PATH = path.resolve(BACKEND_PROCESSED_DIR, "lines.geojson");
const linesDir = process.env.LINES_KML_DIR?.trim() || BACKEND_LINES_DIR;
const processedDir = BACKEND_PROCESSED_DIR;
const SEGMENT_JOIN_TOLERANCE_M = 0.5;
const POINT_SPLIT_DISTANCE_M = 300;
const STITCH_BREAK_DISTANCE_M = 500;
const LOOP_CLOSE_DISTANCE_M = 10;
const CLOSING_POINT_TRIM_DISTANCE_M = 5;
const DISCARD_TAIL_DISTANCE_M = 500;
const VIGO_BOUNDS = {
  minLon: -8.9,
  maxLon: -8.5,
  minLat: 42.1,
  maxLat: 42.3,
} as const;
const VIGO_CENTER: Coordinate = [-8.7207, 42.2406];
const LONG_JUMP_OUTLIER_DISTANCE_M = 1_000;
const SIMPLIFY_TOLERANCE_DEGREES = 0.000005;
const SIMPLIFY_HIGH_QUALITY = true;
const GEOJSON_TRUNCATE_PRECISION = 6;

const coordinateDiagnostics = {
  malformedDiscarded: 0,
  outOfBoundsDiscarded: 0,
  swappedPairs: 0,
  longJumpDiscarded: 0,
};

function decodeEntities(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function stripTags(xmlChunk: string): string {
  return decodeEntities(xmlChunk.replace(/<[^>]+>/g, "").trim());
}

function extractTag(content: string, tagName: string): string | undefined {
  const rx = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "i");
  return content.match(rx)?.[1];
}

function extractBlocks(content: string, tagName: string): string[] {
  const rx = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "gi");
  const blocks: string[] = [];
  let match = rx.exec(content);
  while (match) {
    blocks.push(match[1]);
    match = rx.exec(content);
  }
  return blocks;
}

function isWithinVigoBounds(lon: number, lat: number): boolean {
  return (
    lon >= VIGO_BOUNDS.minLon &&
    lon <= VIGO_BOUNDS.maxLon &&
    lat >= VIGO_BOUNDS.minLat &&
    lat <= VIGO_BOUNDS.maxLat
  );
}

function normalizeCoordinatePair(first: number, second: number): Coordinate | null {
  if (!Number.isFinite(first) || !Number.isFinite(second)) {
    coordinateDiagnostics.malformedDiscarded += 1;
    return null;
  }

  let lon = first;
  let lat = second;
  const currentInBounds = isWithinVigoBounds(lon, lat);
  const swappedInBounds = isWithinVigoBounds(second, first);
  const shouldSwap =
    !currentInBounds &&
    swappedInBounds &&
    (lat < 0 || lon > 0 || Math.abs(lon) > Math.abs(lat));

  if (shouldSwap) {
    coordinateDiagnostics.swappedPairs += 1;
    lon = second;
    lat = first;
  }

  if (!isWithinVigoBounds(lon, lat)) {
    coordinateDiagnostics.outOfBoundsDiscarded += 1;
    return null;
  }

  return [lon, lat];
}

function parseCoordinates(raw: string): Coordinate[] {
  const rows = raw
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);

  const out: Coordinate[] = [];
  for (const row of rows) {
    const [lonRaw, latRaw] = row.split(",");
    const normalized = normalizeCoordinatePair(Number(lonRaw), Number(latRaw));
    if (!normalized) continue;
    out.push(normalized);
  }
  return out;
}

function extractSimpleData(placemarkContent: string): Record<string, string> {
  const rx = /<SimpleData\s+name="([^"]+)">([\s\S]*?)<\/SimpleData>/gi;
  const out: Record<string, string> = {};
  let match = rx.exec(placemarkContent);
  while (match) {
    out[match[1]] = stripTags(match[2]);
    match = rx.exec(placemarkContent);
  }
  return out;
}

function inferDestination(name: string): string | undefined {
  const clean = sanitizeTitle(name);
  const separators = [" - ", " -> ", " / "];
  for (const separator of separators) {
    if (!clean.includes(separator)) continue;
    const parts = clean
      .split(separator)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length > 1) return parts.at(-1);
  }
  return undefined;
}

function inferLineId(
  name: string,
  fileName: string,
  simpleData: Record<string, string>,
): string | null {
  const fromSimple = (simpleData.linea ?? simpleData.line ?? simpleData.route_id)?.trim();
  if (fromSimple && /^[A-Z]?\d{1,3}[A-Z]?$/i.test(fromSimple)) {
    return fromSimple.toUpperCase();
  }

  const candidates = [name, path.basename(fileName, path.extname(fileName))];
  for (const candidate of candidates) {
    const match = candidate.toUpperCase().match(/\b([A-Z]\d{1,2}[A-Z]?)\b/);
    if (match?.[1]) return match[1];
  }

  return null;
}

function coordinatesEqual(a: Coordinate, b: Coordinate): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function cleanCoordinates(coordinates: Coordinate[]): Coordinate[] {
  const cleaned: Coordinate[] = [];
  for (const coordinate of coordinates) {
    if (cleaned.length === 0 || !coordinatesEqual(cleaned.at(-1) as Coordinate, coordinate)) {
      cleaned.push(coordinate);
    }
  }
  return cleaned;
}

function cleanWithTurf(coordinates: Coordinate[]): Coordinate[] {
  if (coordinates.length < 2) return coordinates;

  const feature = {
    type: "Feature" as const,
    properties: {},
    geometry: {
      type: "LineString" as const,
      coordinates,
    },
  };

  const cleaned = cleanCoords(feature);
  return cleaned.geometry.coordinates as Coordinate[];
}

function dropIntermediateLongJumpOutliers(coordinates: Coordinate[]): Coordinate[] {
  if (coordinates.length < 3) return coordinates;

  const filtered: Coordinate[] = [coordinates[0]];
  let index = 1;

  while (index < coordinates.length - 1) {
    const previous = filtered.at(-1) as Coordinate;
    const current = coordinates[index];
    const next = coordinates[index + 1];
    const distanceFromPrevious = endpointDistanceMeters(previous, current);
    const distanceToNext = endpointDistanceMeters(current, next);
    const distancePreviousToNext = endpointDistanceMeters(previous, next);
    const distanceFromCenter = endpointDistanceMeters(VIGO_CENTER, current);
    const nextReturnsNearPrevious =
      distancePreviousToNext <= LONG_JUMP_OUTLIER_DISTANCE_M;
    const nextReturnsNearCenter =
      endpointDistanceMeters(VIGO_CENTER, next) <= LONG_JUMP_OUTLIER_DISTANCE_M;
    const previousNearCenter =
      endpointDistanceMeters(VIGO_CENTER, previous) <= LONG_JUMP_OUTLIER_DISTANCE_M;

    if (
      (distanceFromPrevious > LONG_JUMP_OUTLIER_DISTANCE_M ||
        distanceFromCenter > LONG_JUMP_OUTLIER_DISTANCE_M) &&
      distanceToNext > LONG_JUMP_OUTLIER_DISTANCE_M &&
      (nextReturnsNearPrevious || (previousNearCenter && nextReturnsNearCenter))
    ) {
      coordinateDiagnostics.longJumpDiscarded += 1;
      index += 1;
      continue;
    }

    filtered.push(current);
    index += 1;
  }

  filtered.push(coordinates.at(-1) as Coordinate);
  return filtered;
}

function segmentSignature(coordinates: Coordinate[]): string {
  const forward = coordinates.map(([lon, lat]) => `${lon.toFixed(7)},${lat.toFixed(7)}`).join("|");
  const backward = [...coordinates]
    .reverse()
    .map(([lon, lat]) => `${lon.toFixed(7)},${lat.toFixed(7)}`)
    .join("|");
  return forward < backward ? forward : backward;
}

function endpointDistanceMeters(a: Coordinate, b: Coordinate): number {
  return haversineMeters(a[1], a[0], b[1], b[0]);
}

function segmentLengthScore(coordinates: Coordinate[]): number {
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    total += endpointDistanceMeters(coordinates[index - 1], coordinates[index]);
  }
  return total;
}

function countEndpointConnections(
  segments: Coordinate[][],
  segmentIndex: number,
  endpoint: "start" | "end",
): number {
  const point = endpoint === "start" ? segments[segmentIndex][0] : segments[segmentIndex].at(-1);
  if (!point) return 0;

  let matches = 0;
  for (let otherIndex = 0; otherIndex < segments.length; otherIndex += 1) {
    if (otherIndex === segmentIndex) continue;
    const other = segments[otherIndex];
    const otherStart = other[0];
    const otherEnd = other.at(-1);
    if (
      (otherStart && endpointDistanceMeters(point, otherStart) <= SEGMENT_JOIN_TOLERANCE_M) ||
      (otherEnd && endpointDistanceMeters(point, otherEnd) <= SEGMENT_JOIN_TOLERANCE_M)
    ) {
      matches += 1;
    }
  }

  return matches;
}

function chooseInitialSegment(segments: Coordinate[][]): Coordinate[] {
  if (segments.length === 1) return segments[0];

  let bestCoordinates = segments[0];
  let bestFreeConnections = Number.POSITIVE_INFINITY;
  let bestConnectedOpposite = Number.NEGATIVE_INFINITY;
  let bestLength = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < segments.length; index += 1) {
    const coordinates = segments[index];
    const startConnections = countEndpointConnections(segments, index, "start");
    const endConnections = countEndpointConnections(segments, index, "end");
    const orientations: Array<{ coords: Coordinate[]; freeConnections: number; opposite: number }> =
      [
        { coords: coordinates, freeConnections: startConnections, opposite: endConnections },
        {
          coords: [...coordinates].reverse(),
          freeConnections: endConnections,
          opposite: startConnections,
        },
      ];

    for (const orientation of orientations) {
      const length = segmentLengthScore(orientation.coords);
      const better =
        orientation.freeConnections < bestFreeConnections ||
        (orientation.freeConnections === bestFreeConnections &&
          orientation.opposite > bestConnectedOpposite) ||
        (orientation.freeConnections === bestFreeConnections &&
          orientation.opposite === bestConnectedOpposite &&
          length > bestLength);

      if (better) {
        bestCoordinates = orientation.coords;
        bestFreeConnections = orientation.freeConnections;
        bestConnectedOpposite = orientation.opposite;
        bestLength = length;
      }
    }
  }

  return bestCoordinates;
}

function appendWithoutDuplicate(base: Coordinate[], next: Coordinate[]): Coordinate[] {
  if (base.length === 0) return [...next];
  if (next.length === 0) return [...base];
  const out = [...base];
  const baseTail = out.at(-1) as Coordinate;
  const nextStart = next[0];
  const startIndex = coordinatesEqual(baseTail, nextStart) ? 1 : 0;
  for (let index = startIndex; index < next.length; index += 1) out.push(next[index]);
  return out;
}

function prependWithoutDuplicate(base: Coordinate[], next: Coordinate[]): Coordinate[] {
  if (base.length === 0) return [...next];
  if (next.length === 0) return [...base];
  const baseHead = base[0];
  const nextTail = next.at(-1) as Coordinate;
  const prefix = coordinatesEqual(baseHead, nextTail) ? next.slice(0, -1) : next;
  return [...prefix, ...base];
}

function findBestMatch(chain: Coordinate[], remaining: Coordinate[][]): MatchResult | null {
  const head = chain[0];
  const tail = chain.at(-1) as Coordinate;
  let best: MatchResult | null = null;

  const consider = (
    distanceMeters: number,
    remainingIndex: number,
    side: MatchSide,
    coordinates: Coordinate[],
  ) => {
    if (!best || distanceMeters < best.distanceMeters) {
      best = { distanceMeters, remainingIndex, side, coordinates };
    }
  };

  for (let index = 0; index < remaining.length; index += 1) {
    const segment = remaining[index];
    const start = segment[0];
    const end = segment.at(-1) as Coordinate;

    consider(endpointDistanceMeters(tail, start), index, "tail", segment);
    consider(endpointDistanceMeters(tail, end), index, "tail", [...segment].reverse());
    consider(endpointDistanceMeters(head, end), index, "head", segment);
    consider(endpointDistanceMeters(head, start), index, "head", [...segment].reverse());
  }

  return best;
}

function simplifyCoordinates(coordinates: Coordinate[]): Coordinate[] {
  const normalized = normalizeLineCoordinates(coordinates);
  if (normalized.length < 3) return normalized;

  const feature: LineGeometryFeature = {
    type: "Feature",
    properties: {
      id: "__TMP__",
      name: "__TMP__",
    },
    geometry: {
      type: "LineString",
      coordinates: normalized,
    },
  };

  const simplified = simplify(feature, {
    tolerance: SIMPLIFY_TOLERANCE_DEGREES,
    highQuality: SIMPLIFY_HIGH_QUALITY,
    mutate: false,
  });

  const simplifiedCoordinates = normalizeLineCoordinates(
    simplified.geometry.coordinates as Coordinate[],
  );
  return simplifiedCoordinates.length >= 2 ? simplifiedCoordinates : normalized;
}

function dropDuplicateClosingPoint(coordinates: Coordinate[]): Coordinate[] {
  if (coordinates.length < 3) return coordinates;

  const first = coordinates[0];
  const last = coordinates.at(-1) as Coordinate;
  if (
    coordinatesEqual(first, last) ||
    endpointDistanceMeters(first, last) <= CLOSING_POINT_TRIM_DISTANCE_M
  ) {
    return coordinates.slice(0, -1);
  }

  return coordinates;
}

function discardTailAfterLargeJump(coordinates: Coordinate[]): Coordinate[] {
  if (coordinates.length < 2) return coordinates;

  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const next = coordinates[index];
    if (endpointDistanceMeters(previous, next) > DISCARD_TAIL_DISTANCE_M) {
      return coordinates.slice(0, index);
    }
  }

  return coordinates;
}

function trimArtificialClosure(coordinates: Coordinate[]): Coordinate[] {
  if (coordinates.length < 4) return coordinates;

  const first = coordinates[0];
  const last = coordinates.at(-1) as Coordinate;
  const penultimate = coordinates.at(-2) as Coordinate;
  const closingDistance = endpointDistanceMeters(first, last);
  const returnJumpDistance = endpointDistanceMeters(penultimate, last);

  if (
    closingDistance <= LOOP_CLOSE_DISTANCE_M &&
    returnJumpDistance > POINT_SPLIT_DISTANCE_M
  ) {
    return coordinates.slice(0, -1);
  }

  return coordinates;
}

function normalizeLineCoordinates(coordinates: Coordinate[]): Coordinate[] {
  let normalized = cleanCoordinates(coordinates);
  normalized = dropIntermediateLongJumpOutliers(normalized);
  normalized = cleanWithTurf(normalized);
  normalized = dropDuplicateClosingPoint(normalized);
  normalized = discardTailAfterLargeJump(normalized);
  normalized = trimArtificialClosure(normalized);
  normalized = dropIntermediateLongJumpOutliers(normalized);
  normalized = cleanCoordinates(normalized);
  normalized = cleanWithTurf(normalized);
  normalized = dropDuplicateClosingPoint(normalized);
  return normalized.length >= 2 ? normalized : [];
}

function splitCoordinatesByDistance(coordinates: Coordinate[]): Coordinate[][] {
  const trimmed = normalizeLineCoordinates(coordinates);
  if (trimmed.length < 2) return [];

  const parts: Coordinate[][] = [];
  let current: Coordinate[] = [trimmed[0]];

  for (let index = 1; index < trimmed.length; index += 1) {
    const previous = trimmed[index - 1];
    const next = trimmed[index];
    const gapMeters = endpointDistanceMeters(previous, next);

    if (gapMeters > POINT_SPLIT_DISTANCE_M) {
      if (current.length >= 2) parts.push(current);
      current = [next];
      continue;
    }

    current.push(next);
  }

  if (current.length >= 2) parts.push(current);
  return parts
    .map((part) => simplifyCoordinates(part))
    .map((part) => normalizeLineCoordinates(part))
    .filter((part) => part.length >= 2);
}

function stitchSegments(lineId: string, segments: ParsedSegment[]): StitchedLine | null {
  const uniqueSegments = new Map<string, ParsedSegment>();
  for (const segment of segments) {
    const cleaned = cleanCoordinates(segment.coordinates);
    if (cleaned.length < 2) continue;
    const signature = segmentSignature(cleaned);
    if (!uniqueSegments.has(signature)) {
      uniqueSegments.set(signature, { ...segment, coordinates: cleaned });
    }
  }

  const remaining = Array.from(uniqueSegments.values()).map((segment) => [...segment.coordinates]);
  if (remaining.length === 0) return null;

  const parts: Coordinate[][] = [];
  let stitchedSegments = 0;
  while (remaining.length > 0) {
    const initial = chooseInitialSegment(remaining);
    const initialIndex = remaining.findIndex(
      (segment) => segmentSignature(segment) === segmentSignature(initial),
    );
    if (initialIndex < 0) break;

    remaining.splice(initialIndex, 1);
    let chain = [...initial];
    stitchedSegments += 1;

    while (remaining.length > 0) {
      const match = findBestMatch(chain, remaining);
      if (!match || match.distanceMeters > STITCH_BREAK_DISTANCE_M) break;

      remaining.splice(match.remainingIndex, 1);
      chain =
        match.side === "tail"
          ? appendWithoutDuplicate(chain, match.coordinates)
          : prependWithoutDuplicate(chain, match.coordinates);
      stitchedSegments += 1;
    }

    parts.push(...splitCoordinatesByDistance(chain));
  }

  const source = segments[0];
  if (parts.length === 0) return null;

  return {
    id: lineId,
    name: source.name,
    destination: source.destination,
    parts,
    totalSegments: uniqueSegments.size,
    stitchedSegments,
  };
}

function parseSegmentsFromKml(content: string, fileName: string): ParsedSegment[] {
  const placemarks = extractBlocks(content, "Placemark");
  const parsedSegments: ParsedSegment[] = [];

  for (const placemark of placemarks) {
    const nameRaw = stripTags(extractTag(placemark, "name") ?? "");
    const simpleData = extractSimpleData(placemark);
    const lineId = inferLineId(nameRaw, fileName, simpleData);
    if (!lineId) continue;

    const lineStrings = extractBlocks(placemark, "LineString");
    if (lineStrings.length === 0) continue;

    const displayName = sanitizeTitle(nameRaw || lineId);
    const destination = inferDestination(nameRaw);

    for (const lineString of lineStrings) {
      const rawCoordinates = stripTags(extractTag(lineString, "coordinates") ?? "");
      const coordinates = parseCoordinates(rawCoordinates);
      if (coordinates.length < 2) continue;

      parsedSegments.push({
        id: lineId,
        name: displayName,
        destination,
        coordinates,
      });
    }
  }

  return parsedSegments;
}

async function assertKmlFilesExist(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(linesDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `No existe la carpeta de lineas: ${linesDir}. Ejecuta primero "npm run sync:ckan -w backend".`,
      );
    }
    throw error;
  }

  const kmlFiles = entries.filter((name) => name.toLowerCase().endsWith(".kml"));
  if (kmlFiles.length === 0) {
    throw new Error(
      `No se encontraron archivos .kml en ${linesDir}. Ejecuta primero "npm run sync:ckan -w backend".`,
    );
  }

  console.log(`[build:lines-geojson] KML detectados (${kmlFiles.length}):`);
  for (const file of kmlFiles) console.log(`  - ${file}`);
  return kmlFiles;
}

async function buildGeoJsonFromKml(): Promise<LineGeometryFeatureCollection> {
  const kmlFiles = await assertKmlFilesExist();
  const grouped = new Map<string, ParsedSegment[]>();

  for (const fileName of kmlFiles) {
    const filePath = path.join(linesDir, fileName);
    const raw = await fs.readFile(filePath, "utf8");
    const segments = parseSegmentsFromKml(raw, fileName);
    for (const segment of segments) {
      const key = segment.id.toUpperCase();
      const bucket = grouped.get(key) ?? [];
      bucket.push({ ...segment, id: key });
      grouped.set(key, bucket);
    }
  }

  const features: LineGeometryFeature[] = [];
  let splitLines = 0;
  for (const [lineId, segments] of grouped.entries()) {
    const stitched = stitchSegments(lineId, segments);
    if (!stitched || stitched.parts.length === 0) continue;
    if (stitched.parts.length > 1) splitLines += 1;

    console.log(
      `[linea:stitch] id=${stitched.id} segmentos=${stitched.stitchedSegments}/${stitched.totalSegments} parts=${stitched.parts.length} coords=${stitched.parts.reduce((total, part) => total + part.length, 0)}`,
    );

    const geometry =
      stitched.parts.length === 1
        ? {
            type: "LineString" as const,
            coordinates: stitched.parts[0],
          }
        : {
            type: "MultiLineString" as const,
            coordinates: stitched.parts,
          };

    features.push({
      type: "Feature",
      properties: {
        id: stitched.id,
        name: stitched.name,
        destination: stitched.destination,
      },
      geometry,
    } as unknown as LineGeometryFeature);
  }

  features.sort((a, b) => a.properties.id.localeCompare(b.properties.id, "es-ES"));
  console.log(`[resumen] lineas divididas por saltos=${splitLines}`);
  return truncate(
    {
      type: "FeatureCollection",
      features,
    },
    {
      precision: GEOJSON_TRUNCATE_PRECISION,
      coordinates: 2,
      mutate: false,
    },
  ) as LineGeometryFeatureCollection;
}

function printCoordinateDiagnostics(): void {
  console.log(
    `[diagnostico:coords] malformedDiscarded=${coordinateDiagnostics.malformedDiscarded} outOfBoundsDiscarded=${coordinateDiagnostics.outOfBoundsDiscarded} swappedPairs=${coordinateDiagnostics.swappedPairs} longJumpDiscarded=${coordinateDiagnostics.longJumpDiscarded}`,
  );
}

await fs.mkdir(processedDir, { recursive: true });

const geo = await buildGeoJsonFromKml();
printCoordinateDiagnostics();
if (geo.features.length === 0) {
  throw new Error(
    `Se encontraron KML en ${linesDir}, pero no se pudo extraer ninguna linea valida.`,
  );
}

await fs.writeFile(LINES_GEOJSON_PATH, JSON.stringify(geo, null, 2), "utf8");

const rawStops = await fetchParadasJson();
const freshStops = jsonToBusStops(rawStops);
const metadataStops = await readEnrichedStopsFile();
const stops = mergeStopsWithMetadata(freshStops, metadataStops);
if (stops.length === 0) {
  throw new Error("No se pudo procesar ninguna parada desde el dataset de paradas.");
}

const index = buildStopLineIndex(stops, geo, 150);
const enrichedStops = enrichStopsWithLines(stops, index);
for (const stop of enrichedStops) {
  console.log(`[parada] id=${stop.id} lines=${(stop.lines ?? []).join(",") || "-"}`);
}
await writeStopLineArtifacts(index, enrichedStops);

const stopsWithLines = enrichedStops.filter((stop) => (stop.lines ?? []).length > 0).length;
console.log(
  `[resumen] paradas con lineas=${stopsWithLines}/${enrichedStops.length}, lineas procesadas=${geo.features.length}`,
);
console.log(
  `[parametros] stitchToleranceM=${SEGMENT_JOIN_TOLERANCE_M} pointSplitDistanceM=${POINT_SPLIT_DISTANCE_M} stitchBreakDistanceM=${STITCH_BREAK_DISTANCE_M} loopCloseDistanceM=${LOOP_CLOSE_DISTANCE_M} closingPointTrimDistanceM=${CLOSING_POINT_TRIM_DISTANCE_M} discardTailDistanceM=${DISCARD_TAIL_DISTANCE_M} vigoBounds=${VIGO_BOUNDS.minLon},${VIGO_BOUNDS.minLat}..${VIGO_BOUNDS.maxLon},${VIGO_BOUNDS.maxLat} vigoCenter=${VIGO_CENTER[0]},${VIGO_CENTER[1]} longJumpOutlierDistanceM=${LONG_JUMP_OUTLIER_DISTANCE_M} truncatePrecision=${GEOJSON_TRUNCATE_PRECISION} simplifyToleranceDeg=${SIMPLIFY_TOLERANCE_DEGREES} simplifyHighQuality=${SIMPLIFY_HIGH_QUALITY}`,
);
console.log("Artefactos generados: lines.geojson, stop-lines-index.json, stops.enriched.json");
