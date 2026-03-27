import type { BusStop } from "@autobuses/shared";
import axios from "axios";
import { apiClient } from "./client";

export async function fetchStopById(id: string): Promise<BusStop> {
  const { data } = await apiClient.get<BusStop>(`/api/v1/stops/${encodeURIComponent(id)}`);
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
