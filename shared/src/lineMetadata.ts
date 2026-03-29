export interface LineMetadata {
  color: string;
  icon: string;
  friendlyName: string;
}

const DEFAULT_METADATA: LineMetadata = {
  color: "#475569",
  icon: "bus",
  friendlyName: "Linea urbana",
};

export const LINE_METADATA: Record<string, LineMetadata> = {
  C1: { color: "#dc2626", icon: "bus", friendlyName: "Circular Centro C1" },
  C2: { color: "#ea580c", icon: "bus", friendlyName: "Circular Centro C2" },
  C3: { color: "#7c3aed", icon: "bus", friendlyName: "Circular Centro C3" },
  C4: { color: "#be185d", icon: "bus", friendlyName: "Circular Centro C4" },
  C5: { color: "#0f766e", icon: "bus", friendlyName: "Circular Centro C5" },
  L4: { color: "#2563eb", icon: "bus", friendlyName: "Linea 4" },
  L5: { color: "#1d4ed8", icon: "bus", friendlyName: "Linea 5" },
  L5A: { color: "#1e40af", icon: "bus", friendlyName: "Linea 5A" },
  L6: { color: "#0ea5e9", icon: "bus", friendlyName: "Linea 6" },
  L7: { color: "#0891b2", icon: "bus", friendlyName: "Linea 7" },
  L8: { color: "#7c2d12", icon: "bus", friendlyName: "Linea 8" },
  L9: { color: "#334155", icon: "bus", friendlyName: "Linea 9" },
  A: { color: "#15803d", icon: "bus", friendlyName: "Aeropuerto" },
};

export function resolveLineMetadata(lineId: string): LineMetadata {
  const key = lineId.trim().toUpperCase();
  return (
    LINE_METADATA[key] ??
    LINE_METADATA[key.replace(/[A-Z]$/, "")] ??
    DEFAULT_METADATA
  );
}
