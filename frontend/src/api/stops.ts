import type { BusStop, NearbyBusStop } from "@autobuses/shared";
import type { LiveArrival } from "@autobuses/shared";
import axios from "axios";
import { apiClient } from "./client";

export interface LiveStopResponse {
  arrivals: LiveArrival[];
  isTheoretical: boolean;
  message?: string;
}

type LiveArrivalApi = {
  line?: string;
  minutes?: number;
  destination?: string;
};

type LiveResponseApi =
  | LiveArrival[]
  | LiveArrivalApi[]
  | {
      arrivals?: LiveArrival[] | LiveArrivalApi[];
      isTheoretical?: boolean;
      message?: string;
    };

function resolveRequestUrl(pathname: string): string {
  const trimmedBase = apiClient.defaults.baseURL?.replace(/\/$/, "");
  if (trimmedBase) return `${trimmedBase}${pathname}`;
  if (typeof window !== "undefined") {
    return new URL(pathname, window.location.origin).toString();
  }
  return pathname;
}

function isLegacyLiveArrival(value: unknown): value is LiveArrival {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<LiveArrival>;
  return (
    typeof row.linea === "string" &&
    typeof row.destino === "string" &&
    typeof row.tiempo_minutos === "number"
  );
}

function isApiLiveArrival(value: unknown): value is LiveArrivalApi {
  if (!value || typeof value !== "object") return false;
  const row = value as LiveArrivalApi;
  return (
    typeof row.line === "string" &&
    typeof row.destination === "string" &&
    typeof row.minutes === "number"
  );
}

function normalizeLiveArrival(value: unknown, isTheoretical?: boolean): LiveArrival | null {
  if (isLegacyLiveArrival(value)) {
    return {
      ...value,
      ...(isTheoretical !== undefined ? { isTheoretical } : {}),
    };
  }

  if (isApiLiveArrival(value)) {
    return {
      linea: value.line,
      destino: value.destination,
      tiempo_minutos: value.minutes,
      ...(isTheoretical !== undefined ? { isTheoretical } : {}),
    };
  }

  return null;
}

export async function fetchStops(): Promise<BusStop[]> {
  const { data } = await apiClient.get<BusStop[]>("/api/stops");
  return data;
}

export async function fetchStopById(id: string): Promise<BusStop> {
  const { data } = await apiClient.get<BusStop>(`/api/v1/stops/${encodeURIComponent(id)}`);
  return data;
}

export async function fetchLiveByStopId(stopId: string): Promise<LiveStopResponse> {
  const requestPath = `/api/live/${encodeURIComponent(stopId)}`;
  console.log("[live/frontend] request", {
    stopId,
    url: resolveRequestUrl(requestPath),
    baseURL: apiClient.defaults.baseURL ?? "(vite-proxy:/api -> http://localhost:3001)",
  });
  const { data } = await apiClient.get<LiveResponseApi>(requestPath);

  if (Array.isArray(data)) {
    const response = {
      arrivals: data
        .map((arrival) => normalizeLiveArrival(arrival))
        .filter((arrival): arrival is LiveArrival => arrival !== null),
      isTheoretical: data.every(
        (arrival) => isLegacyLiveArrival(arrival) && arrival.isTheoretical === true,
      ),
    };
    console.log("[live/frontend] Estado de la respuesta", {
      "ID buscado": stopId,
      "ID encontrado en API": "n/d-desde-frontend",
      "Estado de la respuesta": response.isTheoretical ? "legacy-theoretical" : "legacy-live",
    });
    return response;
  }

  const theoretical = data.isTheoretical === true;
  const arrivals = Array.isArray(data.arrivals)
    ? data.arrivals
        .map((arrival) => normalizeLiveArrival(arrival, theoretical))
        .filter((arrival): arrival is LiveArrival => arrival !== null)
    : [];

  const response = {
    arrivals,
    isTheoretical: theoretical,
    message: typeof data.message === "string" ? data.message : undefined,
  };
  console.log("[live/frontend] Estado de la respuesta", {
    "ID buscado": stopId,
    "ID encontrado en API": "ver-backend-log",
    "Estado de la respuesta": response.isTheoretical ? "theoretical" : "live",
  });
  return response;
}

export async function fetchNearbyStops(lat: number, lng: number): Promise<NearbyBusStop[]> {
  const { data } = await apiClient.get<NearbyBusStop[]>("/api/v1/stops/nearby", {
    params: { lat, lng },
  });
  return data;
}

export function formatStopError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const body = err.response?.data as { error?: string; detail?: string } | undefined;
    const msg = body?.error ?? body?.detail;
    if (typeof msg === "string" && msg) return msg;
    if (err.response?.status === 404) return "Parada no encontrada.";
    return err.message || "Error de red";
  }
  return err instanceof Error ? err.message : "Error desconocido";
}
