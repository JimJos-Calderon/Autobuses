import type { BusStop, NearbyBusStop } from "@autobuses/shared";
import type { LiveArrival } from "@autobuses/shared";
import axios from "axios";
import { apiClient } from "./client";

export async function fetchStops(): Promise<BusStop[]> {
  const { data } = await apiClient.get<BusStop[]>("/api/stops");
  return data;
}

export async function fetchStopById(id: string): Promise<BusStop> {
  const { data } = await apiClient.get<BusStop>(`/api/v1/stops/${encodeURIComponent(id)}`);
  return data;
}

export async function fetchLiveByStopId(stopId: string): Promise<LiveArrival[]> {
  const { data } = await apiClient.get<
    LiveArrival[] | { arrivals?: LiveArrival[]; isTheoretical?: boolean }
  >(`/api/live/${encodeURIComponent(stopId)}`);
  if (Array.isArray(data)) return data;
  return Array.isArray(data.arrivals) ? data.arrivals : [];
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
