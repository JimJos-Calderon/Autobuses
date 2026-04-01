import type {
  LineGeometryFeatureCollection,
  LineSummary,
} from "@autobuses/shared";
import { apiClient } from "./client";
import type { LineDirection } from "../types/lineDirection";

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

/**
 * Pide la geometría de una línea para un sentido específico.
 * Arma el ID compuesto "{lineId}_{direction}" (ej. "C1_ida", "10_vuelta")
 * que coincide con los IDs en lines.geojson.
 */
export async function fetchLineGeometry(
  lineId: string,
  direction: LineDirection,
): Promise<LineGeometryFeatureCollection> {
  const compositeId = `${lineId}_${direction}`;
  console.log(`[fetchLineGeometry] pidiendo /${compositeId}/geometry`);
  const { data } = await apiClient.get<LineGeometryFeatureCollection>(
    `/api/v1/lines/${encodeURIComponent(compositeId)}/geometry`,
  );
  return data;
}
