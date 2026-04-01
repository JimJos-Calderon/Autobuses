import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSED_DIR = path.resolve(__dirname, "../../data/processed");
const STOPS_FILE = path.join(PROCESSED_DIR, "stops.enriched.json");
const SEQUENCES_FILE = path.join(PROCESSED_DIR, "official-sequences.json");
const METADATA_FILE = path.join(PROCESSED_DIR, "vitrasa-stops-metadata.json");
const OUTPUT_ALIAS_FILE = path.join(PROCESSED_DIR, "alias-map.json");

const MATCH_RADIUS_METERS = 30;

interface Stop {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

interface VitrasaMetadata {
  id: string;
  name: string;
  lat?: number;
  lon?: number;
}

interface Sequences {
  [lineId: string]: {
    ida: string[];
    vuelta: string[];
  };
}

function getDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizeName(name: string): string {
  return name.toUpperCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]/g, " ")
    .replace(/\s+/g, " ").trim();
}

async function findDiscrepancies() {
  console.log("--- Iniciando Generación de Alias Map (Spatial Match) ---");

  const [rawSequences, rawStops, rawMeta] = await Promise.all([
    fs.readFile(SEQUENCES_FILE, "utf8").catch(() => "{}"),
    fs.readFile(STOPS_FILE, "utf8"),
    fs.readFile(METADATA_FILE, "utf8").catch(() => "{}")
  ]);

  const sequences: Sequences = JSON.parse(rawSequences);
  const allStops: Stop[] = JSON.parse(rawStops);
  const vitrasaMeta: Record<string, VitrasaMetadata> = JSON.parse(rawMeta);

  const stopMap = new Map(allStops.map((s) => [s.id, s]));
  const aliasMap: Record<string, string> = {};
  
  const vitrasaIds = new Set<string>();
  Object.values(sequences).forEach((s) => {
    s.ida.forEach(id => vitrasaIds.add(id));
    s.vuelta.forEach(id => vitrasaIds.add(id));
  });

  console.log(`Analizando ${vitrasaIds.size} IDs de Vitrasa...`);

  let countSpatial = 0;
  let countName = 0;
  let countFail = 0;

  for (const vId of vitrasaIds) {
    if (stopMap.has(vId)) continue;

    const meta = vitrasaMeta[vId];
    if (!meta) continue;

    // 1. Intento por Proximidad Geográfica (Radio 30m)
    if (meta.lat && meta.lon) {
      let closest: Stop | null = null;
      let minDist = Infinity;

      for (const stop of allStops) {
        const dist = getDistance(meta.lat, meta.lon, stop.lat, stop.lon);
        if (dist < MATCH_RADIUS_METERS && dist < minDist) {
          minDist = dist;
          closest = stop;
        }
      }

      if (closest) {
        aliasMap[vId] = closest.id;
        countSpatial++;
        continue;
      }
    }

    // 2. Intento por Similitud de Nombre (Fallback)
    const vNameNorm = normalizeName(meta.name);
    const nameMatch = allStops.find(s => normalizeName(s.name) === vNameNorm);
    if (nameMatch) {
      aliasMap[vId] = nameMatch.id;
      countName++;
      continue;
    }

    countFail++;
    process.stdout.write(`[warn] No se encontró match para ${vId} (${meta.name})\n`);
  }

  await fs.writeFile(OUTPUT_ALIAS_FILE, JSON.stringify(aliasMap, null, 2), "utf8");
  
  console.log("\n--- Resumen de Mapeo ---");
  console.log(`Matching Espacial: ${countSpatial}`);
  console.log(`Matching por Nombre: ${countName}`);
  console.log(`Sin coincidencia: ${countFail}`);
  console.log(`Alias Map guardado en: ${OUTPUT_ALIAS_FILE}`);
}

findDiscrepancies().catch(console.error);
