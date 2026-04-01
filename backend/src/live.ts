import type { LiveArrival } from "@autobuses/shared";
import axios from "axios";
import { load } from "cheerio";
import { Agent as HttpsAgent } from "node:https";
import { sanitizeNullableText } from "./sanitizer.js";
import { fetchTheoreticalArrivals } from "./theoretical.js";

const LIVE_INFOBUS_BASE_URL =
  process.env.LIVE_PARADAS_URL?.trim() ||
  "https://infobus.vitrasa.es:8002/Default.aspx";
const LIVE_TIMEOUT_MS = 5_000;
const LIVE_CACHE_TTL_MS = 20_000;
const LIVE_SLOW_MESSAGE = "Servidor de Vitrasa lento, reintentando...";

const LIVE_INFOBUS_INSECURE_HOSTS = new Set(["infobus.vitrasa.es"]);
const liveInfobusAgent = new HttpsAgent({ rejectUnauthorized: false });

export interface LiveApiArrival {
  line: string;
  minutes: number;
  destination: string;
}

export interface LiveApiResponse {
  arrivals: LiveApiArrival[];
  isTheoretical: boolean;
  message?: string;
}

type CacheEntry = {
  expiresAt: number;
  value: LiveApiResponse;
};

type ScrapedArrival = LiveArrival & {
  rawMinutes: string;
  source: "table" | "text";
};

type ScrapeResult = {
  arrivals: LiveArrival[];
  matchedStopId?: string;
  traces: string[];
};

const liveStopCache = new Map<string, CacheEntry>();

class LiveUpstreamTimeoutError extends Error {
  constructor(url: string) {
    super(`Timeout ${LIVE_TIMEOUT_MS}ms consultando ${url}`);
    this.name = "LiveUpstreamTimeoutError";
  }
}

function normalizeComparableString(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeStopId(value: string): string {
  return normalizeComparableString(value).replace(/\D+/g, "");
}

function compactStopId(value: string): string {
  const digits = normalizeStopId(value);
  if (!digits) return normalizeComparableString(value);
  const compacted = digits.replace(/^0+/, "");
  return compacted || "0";
}

function sanitizeLineLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim().toUpperCase();
}

function parseSpecialMinutes(raw: string): number | undefined {
  const normalized = normalizeComparableString(raw).toLocaleLowerCase("es-ES");
  if (!normalized) return undefined;
  if (normalized === "inminente") return 0;
  if (normalized === "en parada") return 1;
  if (normalized === ">>") return 0;

  const match = normalized.match(/\d+/);
  if (!match) return undefined;

  const minutes = Number(match[0]);
  return Number.isFinite(minutes) ? minutes : undefined;
}

function normalizeRowText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseArrivalFromText(text: string): ScrapedArrival | null {
  const normalized = normalizeRowText(text);
  if (!normalized) return null;

  const tokens = normalized
    .split(/\s*[-–—|·]\s*/)
    .map((part) => normalizeRowText(part))
    .filter(Boolean);

  if (tokens.length < 3) return null;

  const line = sanitizeLineLabel(tokens[0]);
  const rawMinutes = tokens[tokens.length - 1];
  const destination = sanitizeNullableText(tokens.slice(1, -1).join(" - "));
  const minutes = parseSpecialMinutes(rawMinutes);

  if (!line || !destination || minutes === undefined) return null;

  return {
    linea: line,
    destino: destination,
    tiempo_minutos: minutes,
    rawMinutes,
    source: "text",
  };
}

function dedupeLiveArrivals(arrivals: LiveArrival[]): LiveArrival[] {
  const seen = new Set<string>();
  const out: LiveArrival[] = [];

  for (const arrival of arrivals) {
    const key = `${arrival.linea}|${arrival.destino}|${arrival.tiempo_minutos}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(arrival);
  }

  return out;
}

function mapApiArrival(arrival: LiveArrival): LiveApiArrival {
  return {
    line: arrival.linea,
    minutes: arrival.tiempo_minutos,
    destination: arrival.destino,
  };
}

function cloneResponse(value: LiveApiResponse): LiveApiResponse {
  return {
    ...value,
    arrivals: value.arrivals.map((arrival) => ({ ...arrival })),
  };
}

function cacheKeyForStop(stopId: string): string {
  return compactStopId(stopId) || normalizeComparableString(stopId);
}

function getCachedLiveResponse(stopId: string): LiveApiResponse | null {
  const key = cacheKeyForStop(stopId);
  const entry = liveStopCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    liveStopCache.delete(key);
    return null;
  }
  return cloneResponse(entry.value);
}

function setCachedLiveResponse(stopId: string, value: LiveApiResponse): LiveApiResponse {
  const key = cacheKeyForStop(stopId);
  const cachedValue = cloneResponse(value);
  liveStopCache.set(key, {
    expiresAt: Date.now() + LIVE_CACHE_TTL_MS,
    value: cachedValue,
  });
  return cloneResponse(cachedValue);
}

function buildInfobusUrl(stopId: string): string {
  const url = new URL(LIVE_INFOBUS_BASE_URL);
  url.searchParams.set("parada", normalizeComparableString(stopId));
  return url.toString();
}

async function fetchLiveHtml(stopId: string): Promise<string> {
  const url = buildInfobusUrl(stopId);
  const parsedUrl = new URL(url);
  const requiresInsecureTls =
    parsedUrl.protocol === "https:" &&
    parsedUrl.port === "8002" &&
    LIVE_INFOBUS_INSECURE_HOSTS.has(parsedUrl.hostname);

  try {
    const response = await axios.get<string>(url, {
      responseType: "text",
      timeout: LIVE_TIMEOUT_MS,
      httpsAgent: requiresInsecureTls ? liveInfobusAgent : undefined,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "BusVigo-BFF/1.0 (Node; infobus scraper)",
      },
      transitional: {
        silentJSONParsing: true,
      },
    });

    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.code === "ECONNABORTED") {
      throw new LiveUpstreamTimeoutError(url);
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

function parseArrivalsFromTable(html: string): ScrapeResult {
  const $ = load(html);
  const traces: string[] = [];
  const matchedStopId = normalizeComparableString($("#lblParada").first().text()) || undefined;
  const arrivals: ScrapedArrival[] = [];

  $("#GridView1 tr").each((index, row) => {
    if (index === 0) return;

    const cells = $(row)
      .find("td")
      .map((_, cell) => normalizeRowText($(cell).text()))
      .get()
      .filter(Boolean);

    if (cells.length < 3) return;

    const [lineRaw, destinationRaw, minutesRaw] = cells;
    const destination = sanitizeNullableText(destinationRaw);
    const minutes = parseSpecialMinutes(minutesRaw);

    if (!lineRaw || !destination || minutes === undefined) return;

    arrivals.push({
      linea: sanitizeLineLabel(lineRaw),
      destino: destination,
      tiempo_minutos: minutes,
      rawMinutes: minutesRaw,
      source: "table",
    });
  });

  traces.push(`table-rows=${arrivals.length}`);

  if (arrivals.length > 0) {
    arrivals.forEach((arrival) => {
      if (arrival.rawMinutes === ">>") {
        traces.push(`confirmed-realtime:${arrival.linea}:${arrival.destino}`);
      }
    });

    return {
      arrivals: dedupeLiveArrivals(arrivals).sort((a, b) => a.tiempo_minutos - b.tiempo_minutos),
      matchedStopId,
      traces,
    };
  }

  const textCandidates = $("td, span")
    .map((_, node) => normalizeRowText($(node).text()))
    .get()
    .filter((text) => text.includes("-") || text.includes("–") || text.includes("—"));

  for (const candidate of textCandidates) {
    const parsed = parseArrivalFromText(candidate);
    if (parsed) arrivals.push(parsed);
  }

  traces.push(`text-candidates=${textCandidates.length}`);

  arrivals.forEach((arrival) => {
    if (arrival.rawMinutes === ">>") {
      traces.push(`confirmed-realtime:${arrival.linea}:${arrival.destino}`);
    }
  });

  return {
    arrivals: dedupeLiveArrivals(arrivals).sort((a, b) => a.tiempo_minutos - b.tiempo_minutos),
    matchedStopId,
    traces,
  };
}

async function buildTheoreticalResponse(
  stopId: string,
  message?: string,
): Promise<LiveApiResponse> {
  const theoretical = (await fetchTheoreticalArrivals(stopId)).sort(
    (a, b) => a.tiempo_minutos - b.tiempo_minutos,
  );

  return {
    arrivals: theoretical.map((arrival) => mapApiArrival(arrival)),
    isTheoretical: true,
    ...(message ? { message } : {}),
  };
}

export async function fetchLiveRaw(stopId: string): Promise<string> {
  const html = await fetchLiveHtml(stopId);
  console.log("[live/upstream] infobus-html-preview:", html.slice(0, 1200));
  return html;
}

export function parseLiveArrivalsForStop(html: string, stopId: string): ScrapeResult {
  const result = parseArrivalsFromTable(html);
  if (result.arrivals.length === 0) {
    console.log(
      `[DEBUG] No se encontró información live para la parada ${normalizeComparableString(stopId)} en Infobus.`,
    );
  }
  return result;
}

export async function fetchLiveArrivalsSafe(stopId: string): Promise<LiveApiResponse> {
  const cached = getCachedLiveResponse(stopId);
  if (cached) {
    console.log(
      `[live/report] ID buscado=${stopId} | ID encontrado en API=cache:${cacheKeyForStop(stopId)} | Estado de la respuesta=${cached.isTheoretical ? "cache-theoretical" : "cache-live"}`,
    );
    return cached;
  }

  try {
    const raw = await fetchLiveRaw(stopId);
    const { arrivals: liveArrivals, matchedStopId, traces } = parseLiveArrivalsForStop(raw, stopId);

    if (liveArrivals.length > 0) {
      console.log(
        `[live/report] ID buscado=${stopId} | ID encontrado en API=${matchedStopId ?? "sin-etiqueta"} | Estado de la respuesta=live-hit | trazas=${traces.join(",")}`,
      );

      return setCachedLiveResponse(stopId, {
        arrivals: liveArrivals.map((arrival) => mapApiArrival(arrival)),
        isTheoretical: false,
      });
    }

    console.log(
      `[live/report] ID buscado=${stopId} | ID encontrado en API=${matchedStopId ?? "ninguno"} | Estado de la respuesta=infobus-sin-coincidencia->fallback-teorico | trazas=${traces.join(",")}`,
    );
    return setCachedLiveResponse(stopId, await buildTheoreticalResponse(stopId));
  } catch (error) {
    const isTimeout = error instanceof LiveUpstreamTimeoutError;
    const message = isTimeout ? LIVE_SLOW_MESSAGE : undefined;

    console.log(
      `[live/report] ID buscado=${stopId} | ID encontrado en API=error-no-disponible | Estado de la respuesta=${isTimeout ? "timeout-fallback-teorico" : "error-fallback-teorico"}`,
    );

    return setCachedLiveResponse(stopId, await buildTheoreticalResponse(stopId, message));
  }
}
