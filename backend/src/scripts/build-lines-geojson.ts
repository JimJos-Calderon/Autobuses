import fs from "node:fs/promises";
import path from "node:path";
import type { LineGeometryFeatureCollection } from "@autobuses/shared";
import { buildLinesGeoJsonToFile, LINES_GEOJSON_PATH } from "../lines.js";
import { BACKEND_LINES_DIR, BACKEND_PROCESSED_DIR } from "../paths.js";
import { fetchParadasJson, jsonToBusStops } from "../paradas.js";
import { buildStopLineIndex, enrichStopsWithLines, writeStopLineArtifacts } from "../stop-lines.js";

const linesDir = process.env.LINES_KML_DIR?.trim() || BACKEND_LINES_DIR;
const processedDir = BACKEND_PROCESSED_DIR;

async function assertKmlFilesExist(): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(linesDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `No existe la carpeta de lineas: ${linesDir}. Ejecuta primero "npm run sync:ckan -w backend".`,
      );
    }
    throw e;
  }

  const kmlFiles = entries.filter((name) => name.toLowerCase().endsWith(".kml"));
  if (kmlFiles.length === 0) {
    throw new Error(
      `No se encontraron archivos .kml en ${linesDir}. Ejecuta primero "npm run sync:ckan -w backend".`,
    );
  }

  console.log(`[build:lines-geojson] KML detectados (${kmlFiles.length}):`);
  for (const file of kmlFiles) console.log(`  - ${file}`);
}

await fs.mkdir(processedDir, { recursive: true });
await assertKmlFilesExist();

await buildLinesGeoJsonToFile(LINES_GEOJSON_PATH);
const geoRaw = await fs.readFile(LINES_GEOJSON_PATH, "utf8");
const geo = JSON.parse(geoRaw) as LineGeometryFeatureCollection;
if (geo.features.length === 0) {
  throw new Error(
    `Se encontraron KML en ${linesDir}, pero no se pudo extraer ninguna linea valida.`,
  );
}
for (const feature of geo.features) {
  console.log(
    `[linea] id=${feature.properties.id} coords=${feature.geometry.coordinates.length}`,
  );
}
await fs.writeFile(LINES_GEOJSON_PATH, JSON.stringify(geo, null, 2), "utf8");

const rawStops = await fetchParadasJson();
const stops = jsonToBusStops(rawStops);
if (stops.length === 0) {
  throw new Error("No se pudo procesar ninguna parada desde el dataset de paradas.");
}
const index = buildStopLineIndex(stops, geo, 110);
const enrichedStops = enrichStopsWithLines(stops, index);
for (const stop of enrichedStops) {
  console.log(`[parada] id=${stop.id} lines=${(stop.lines ?? []).join(",") || "-"}`);
}
await writeStopLineArtifacts(index, enrichedStops);

const stopsWithLines = enrichedStops.filter((s) => (s.lines ?? []).length > 0).length;
console.log(
  `[resumen] paradas con lineas=${stopsWithLines}/${enrichedStops.length}, lineas procesadas=${geo.features.length}`,
);

console.log("Artefactos generados: lines.geojson, stop-lines-index.json, stops.enriched.json");
