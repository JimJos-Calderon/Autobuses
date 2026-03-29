import fs from "node:fs/promises";
import path from "node:path";
import type {
  BusStop,
  LineGeometryFeature,
  LineGeometryFeatureCollection,
  LineSummary,
} from "@autobuses/shared";
import { resolveLineMetadata } from "@autobuses/shared";
import { BACKEND_LINES_DIR, BACKEND_PROCESSED_DIR } from "./paths.js";
import { buildStopLineIndex, enrichStopsWithLines, writeStopLineArtifacts } from "./stop-lines.js";
import { sanitizeTitle } from "./sanitizer.js";

const DEFAULT_LINES_DIR = BACKEND_LINES_DIR;
export const LINES_GEOJSON_PATH = path.resolve(BACKEND_PROCESSED_DIR, "lines.geojson");

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
  const match = content.match(rx);
  return match?.[1];
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

function parseCoordinates(raw: string): [number, number][] {
  const rows = raw
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((p) => p.trim())
    .filter(Boolean);
  const out: [number, number][] = [];
  for (const row of rows) {
    const [lonRaw, latRaw] = row.split(",");
    const lon = Number(lonRaw);
    const lat = Number(latRaw);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    out.push([lon, lat]);
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

function inferLineId(name: string, fileName: string, simpleData: Record<string, string>): string {
  const fromSimple = (simpleData.linea ?? simpleData.line ?? simpleData.route_id)?.trim();
  if (fromSimple) return fromSimple.toUpperCase();

  const fileId = path.basename(fileName, path.extname(fileName)).toUpperCase();
  const fromName = name.toUpperCase().match(/\b([A-Z]\d{1,2}[A-Z]?)\b/);
  if (fromName?.[1]) return fromName[1];
  const fromFile = fileId.match(/\b([A-Z]\d{1,2}[A-Z]?)\b/);
  if (fromFile?.[1]) return fromFile[1];
  return fileId;
}

function inferDestination(name: string): string | undefined {
  const clean = sanitizeTitle(name);
  const separators = [" - ", " -> ", " / "];
  for (const sep of separators) {
    if (clean.includes(sep)) {
      const chunks = clean.split(sep).map((part) => part.trim()).filter(Boolean);
      if (chunks.length > 1) return chunks[chunks.length - 1];
    }
  }
  return undefined;
}

function parseLineFeaturesFromKml(content: string, fileName: string): LineGeometryFeature[] {
  const placemarks = extractBlocks(content, "Placemark");
  const features: LineGeometryFeature[] = [];

  for (const placemark of placemarks) {
    const nameRaw = stripTags(extractTag(placemark, "name") ?? "");
    const simpleData = extractSimpleData(placemark);
    const lineStrings = extractBlocks(placemark, "LineString");

    const coordinates: [number, number][] = [];
    for (const lineString of lineStrings) {
      const coordsRaw = stripTags(extractTag(lineString, "coordinates") ?? "");
      coordinates.push(...parseCoordinates(coordsRaw));
    }

    if (coordinates.length < 2) continue;

    const id = inferLineId(nameRaw, fileName, simpleData);
    features.push({
      type: "Feature",
      properties: {
        id,
        name: sanitizeTitle(nameRaw || id),
        destination: inferDestination(nameRaw),
      },
      geometry: {
        type: "LineString",
        coordinates,
      },
    });
  }

  return features;
}

function dedupeFeatures(features: LineGeometryFeature[]): LineGeometryFeature[] {
  const byId = new Map<string, LineGeometryFeature>();
  for (const feature of features) {
    const key = feature.properties.id.toUpperCase();
    const existing = byId.get(key);
    if (!existing || feature.geometry.coordinates.length > existing.geometry.coordinates.length) {
      byId.set(key, {
        ...feature,
        properties: {
          ...feature.properties,
          id: key,
        },
      });
    }
  }
  return Array.from(byId.values()).sort((a, b) =>
    a.properties.id.localeCompare(b.properties.id, "es-ES"),
  );
}

function linesDir(): string {
  return process.env.LINES_KML_DIR?.trim() || DEFAULT_LINES_DIR;
}

async function readProcessedLinesGeoJson(): Promise<LineGeometryFeatureCollection | null> {
  try {
    const raw = await fs.readFile(LINES_GEOJSON_PATH, "utf8");
    const parsed = JSON.parse(raw) as LineGeometryFeatureCollection;
    if (!parsed || parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function loadLinesGeometryFromKml(): Promise<LineGeometryFeatureCollection> {
  const dir = linesDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { type: "FeatureCollection", features: [] };
    }
    throw e;
  }

  const kmlFiles = entries.filter((fileName) => fileName.toLowerCase().endsWith(".kml"));
  const features: LineGeometryFeature[] = [];
  for (const fileName of kmlFiles) {
    const filePath = path.join(dir, fileName);
    const raw = await fs.readFile(filePath, "utf8");
    features.push(...parseLineFeaturesFromKml(raw, fileName));
  }

  return { type: "FeatureCollection", features: dedupeFeatures(features) };
}

export async function loadLinesGeometry(): Promise<LineGeometryFeatureCollection> {
  const processed = await readProcessedLinesGeoJson();
  if (processed && processed.features.length > 0) return processed;
  return await loadLinesGeometryFromKml();
}

export async function listLines(): Promise<LineSummary[]> {
  const geo = await loadLinesGeometry();
  return geo.features
    .map((feature) => {
      const metadata = resolveLineMetadata(feature.properties.id);
      return {
        id: feature.properties.id,
        name: sanitizeTitle(feature.properties.name),
        destination: feature.properties.destination,
        color: metadata.color,
        icon: metadata.icon,
        friendlyName: metadata.friendlyName,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id, "es-ES"));
}

export async function findLineGeometryById(
  lineId: string,
): Promise<LineGeometryFeatureCollection | null> {
  const geo = await loadLinesGeometry();
  const wanted = lineId.trim().toUpperCase();
  const match = geo.features.find((feature) => feature.properties.id.toUpperCase() === wanted);
  if (!match) return null;
  const metadata = resolveLineMetadata(match.properties.id);
  return {
    type: "FeatureCollection",
    features: [
      {
        ...match,
        properties: {
          ...match.properties,
          color: metadata.color,
          icon: metadata.icon,
          friendlyName: metadata.friendlyName,
        },
      },
    ],
  };
}

export async function buildLinesGeoJsonToFile(outputPath: string): Promise<void> {
  const geo = await loadLinesGeometryFromKml();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(geo, null, 2), "utf8");
}

export async function buildLinesAndStopIndexArtifacts(stops: BusStop[]): Promise<void> {
  const geo = await loadLinesGeometryFromKml();
  await fs.mkdir(path.dirname(LINES_GEOJSON_PATH), { recursive: true });
  await fs.writeFile(LINES_GEOJSON_PATH, JSON.stringify(geo, null, 2), "utf8");

  const index = buildStopLineIndex(stops, geo, 110);
  const enrichedStops = enrichStopsWithLines(stops, index);
  await writeStopLineArtifacts(index, enrichedStops);
}
