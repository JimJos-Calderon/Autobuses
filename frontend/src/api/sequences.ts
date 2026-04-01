import { apiClient } from "./client";

export type OfficialSequenceRaw = Record<string, { ida: string[]; vuelta: string[] }>;

/**
 * Obtiene el mapeo de secuencias oficiales (ids de paradas) para cada línea
 * y cada sentido, extraído directamente de la web de Vitrasa.
 */
export async function fetchOfficialSequences(): Promise<OfficialSequenceRaw> {
  const { data } = await apiClient.get<OfficialSequenceRaw>("/api/v1/sequences");
  return data;
}
