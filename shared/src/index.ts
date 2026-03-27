/** Parada de autobús (Vigo / datos abertos). */
export interface BusStop {
  id: string;
  name: string;
  /** Coordenadas WGS84 si el origen las incluye */
  lat?: number;
  lon?: number;
}
