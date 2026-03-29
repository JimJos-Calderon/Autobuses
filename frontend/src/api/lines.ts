import type {
  LineGeometryFeatureCollection,
  LineSummary,
} from "@autobuses/shared";
import { apiClient } from "./client";

export async function fetchLines(): Promise<LineSummary[]> {
  const { data } = await apiClient.get<LineSummary[]>("/api/v1/lines");
  if (!Array.isArray(data) || data.length === 0) {
    console.warn(
      "[fetchLines] Array vacio desde /api/v1/lines. Revisa proxy/baseURL:",
      apiClient.defaults.baseURL ?? "(vacio, usando proxy de Vite)",
    );
  }
  return data;
}

export async function fetchLineGeometry(
  lineId: string,
): Promise<LineGeometryFeatureCollection> {
  const { data } = await apiClient.get<LineGeometryFeatureCollection>(
    `/api/v1/lines/${encodeURIComponent(lineId)}/geometry`,
  );
  return data;
}
