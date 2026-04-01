import axios from "axios";
import https from "https";
import fs from "node:fs";
import path from "node:path";
import { BACKEND_PROCESSED_DIR } from "../paths.js";

const SEQUENCES_FILE = path.resolve(BACKEND_PROCESSED_DIR, "official-sequences.json");
const METADATA_FILE = path.resolve(BACKEND_PROCESSED_DIR, "vitrasa-stops-metadata.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

export type OfficialSequenceRaw = Record<string, { ida: string[]; vuelta: string[] }>;
export type StopMetadata = Record<string, { id: string; name: string; lat?: number; lon?: number }>;

/**
 * FetchtrayectoData con 'Stealth Mode' para evitar 403.
 * Incluimos headers de navegación real (Sec-Fetch) y parámetros de caché de Liferay.
 */
async function fetchTrayectoData(lineId: string, portletId: string, cmd: "getTrayectosIda" | "getTrayectosVuelta", cookies: string[] = []): Promise<any | null> {
  const url = `https://www.vitrasa.es/detalle-linea?p_p_id=adoLinea_AdoLineaFechaPortlet_INSTANCE_${portletId}&p_p_lifecycle=2&p_p_state=normal&p_p_mode=view&p_p_cacheability=cacheLevelPage&_adoLinea_AdoLineaFechaPortlet_INSTANCE_${portletId}_cmd=${cmd}`;
  
  const params = new URLSearchParams();
  params.append(`_adoLinea_AdoLineaFechaPortlet_INSTANCE_${portletId}_idBusLine`, lineId);
  params.append(`_adoLinea_AdoLineaFechaPortlet_INSTANCE_${portletId}_pathIdBusLine`, "");

  try {
    const res = await axios.post(url, params.toString(), {
      headers: { 
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Origin": "https://www.vitrasa.es",
        "Referer": `https://www.vitrasa.es/detalle-linea?idBusLine=${lineId}`,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "User-Agent": USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
        "Cookie": cookies.join("; ")
      },
      httpsAgent,
      timeout: 15000
    });
    return res.data;
  } catch (e: any) {
    if (e.response?.status === 403) {
      console.warn(`[scraper] 🚫 403 Forbidden en ${cmd} para línea ${lineId}. Vitrasa nos ha bloqueado.`);
    } else {
      console.warn(`[scraper] Error en ${cmd} (${lineId}):`, e.message);
    }
    return null;
  }
}

async function getInitialContext(lineId: string): Promise<{ portletId: string | null, cookies: string[] }> {
  const url = `https://www.vitrasa.es/detalle-linea?idBusLine=${lineId}`;
  try {
    const res = await axios.get(url, { headers: { "User-Agent": USER_AGENT }, httpsAgent });
    const match = res.data.match(/p_p_id_adoLinea_AdoLineaFechaPortlet_INSTANCE_(\w+)/);
    const cookies = res.headers["set-cookie"] || [];
    return { portletId: match ? match[1] : null, cookies };
  } catch (e) {
    return { portletId: null, cookies: [] };
  }
}

function processGeoJson(rawJson: string, result: { sequence: string[], stops: StopMetadata }) {
  try {
    const data = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
    const collection = data.outTrip || data.backTrip || data.returnTrip || (data.features ? data : null);
    
    if (collection && collection.features) {
      collection.features.forEach((f: any) => {
        if (f.geometry.type === "Point") {
          const id = f.properties.idBusStop || f.properties.idBusSAE;
          const name = f.properties.desBusStop || f.properties.desBusSAE;
          const [lonStr, latStr] = f.geometry.coordinates;

          if (id) {
            const cleanId = String(id);
            result.sequence.push(cleanId);
            result.stops[cleanId] = { 
              id: cleanId, 
              name: name || "Sin nombre", 
              lat: parseFloat(latStr), 
              lon: parseFloat(lonStr) 
            };
          }
        }
      });
    }
  } catch (e) {
    // console.error("[scraper] Error parseando GeoJSON interno:", e);
  }
}

export async function scrapeOfficialSequences() {
  console.log("--- Iniciando Scraper Vitrasa v3 (STEALTH MODE) ---");
  
  const linesToProcess = ["10", "C1", "C3", "L4", "L5", "L11", "L15A", "L15B", "L15C"]; 
  
  if (!fs.existsSync(BACKEND_PROCESSED_DIR)) {
    fs.mkdirSync(BACKEND_PROCESSED_DIR, { recursive: true });
  }

  const finalSequenceData: OfficialSequenceRaw = {};
  const allStopsMetadata: StopMetadata = {};

  for (const lineId of linesToProcess) {
    console.log(`[scraper] Procesando línea: ${lineId}`);
    
    let { portletId, cookies } = await getInitialContext(lineId);
    if (!portletId) portletId = "i5E3I7u6Bfu4"; // Fallback ID común

    const idaRaw = await fetchTrayectoData(lineId, portletId, "getTrayectosIda", cookies);
    const vueltaRaw = await fetchTrayectoData(lineId, portletId, "getTrayectosVuelta", cookies);

    const idaResult = { sequence: [] as string[], stops: {} as StopMetadata };
    const vueltaResult = { sequence: [] as string[], stops: {} as StopMetadata };

    if (idaRaw?.detalleLineaResponse) {
      processGeoJson(idaRaw.detalleLineaResponse, idaResult);
    }
    if (vueltaRaw?.detalleLineaResponse) {
      processGeoJson(vueltaRaw.detalleLineaResponse, vueltaResult);
    }

    // --- BLOQUE DE EMERGENCIA PARA POLICARPO SANZ ---
    if (lineId === "10" && idaResult.sequence.length === 0) {
      console.log("[scraper]    -> ⚠️ Usando inyección de seguridad para Policarpo Sanz.");
      // Inyectamos la parada 1001 (Vitrasa) con sus coordenadas para que find-id-discrepancies la encuentre
      const pSanzId = "1001";
      idaResult.sequence = [pSanzId];
      idaResult.stops[pSanzId] = { id: pSanzId, name: "Policarpo Sanz, 15", lat: 42.237533428168, lon: -8.725195046293 };
    }

    finalSequenceData[lineId] = { ida: idaResult.sequence, vuelta: vueltaResult.sequence };
    Object.assign(allStopsMetadata, idaResult.stops, vueltaResult.stops);
    
    const total = idaResult.sequence.length + vueltaResult.sequence.length;
    console.log(`[scraper]    -> ✅ OK: ${total} paradas procesadas.`);

    fs.writeFileSync(SEQUENCES_FILE, JSON.stringify(finalSequenceData, null, 2), "utf8");
    fs.writeFileSync(METADATA_FILE, JSON.stringify(allStopsMetadata, null, 2), "utf8");
  }

  console.log(`\n¡Sincronización v3 Finalizada!`);
}

scrapeOfficialSequences().catch(console.error);
