/** Parada de autobús (Vigo / datos abertos). */
export interface BusStop {
  id: string;
  name: string;
  /** Coordenadas WGS84 si el origen las incluye */
  lat?: number;
  lon?: number;
  /** Lineas que pasan por la parada (precomputado en backend). */
  lines?: string[];
}

export interface NearbyBusStop extends BusStop {
  distance_m: number;
}

export interface LiveArrival {
  linea: string;
  tiempo_minutos: number;
  destino: string;
  isTheoretical?: boolean;
}

export interface LineSummary {
  id: string;
  name: string;
  destination?: string;
  color: string;
  icon: string;
  friendlyName: string;
}

export interface LineGeometryFeature {
  type: "Feature";
  properties: {
    id: string;
    name: string;
    destination?: string;
    color?: string;
    icon?: string;
    friendlyName?: string;
  };
  geometry: {
    type: "LineString";
    coordinates: [number, number][];
  };
}

export interface LineGeometryFeatureCollection {
  type: "FeatureCollection";
  features: LineGeometryFeature[];
}

export { LINE_METADATA, resolveLineMetadata } from "./lineMetadata.js";
export type { LineMetadata } from "./lineMetadata.js";
