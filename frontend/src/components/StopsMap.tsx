import type { BusStop, LineGeometryFeatureCollection } from "@autobuses/shared";
import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from "maplibre-gl";
import { useCallback, useEffect, useRef } from "react";
import type { JourneyRoute } from "../utils/journeyPlanner";

interface StopsMapProps {
  stops: BusStop[];
  selectedStopId: string | null;
  onSelectStop: (stopId: string) => void;
  nearbyStopIds: string[];
  userLocation: { lat: number; lng: number } | null;
  followUser: boolean;
  selectedJourney?: JourneyRoute | null;
  journeyGeometries?: Record<string, LineGeometryFeatureCollection>;
  journeyNodes?: { origin: { lat: number; lng: number }; destination: { lat: number; lng: number } } | null;
}

const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://a.tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

const STOPS_SOURCE_ID = "stops-source";
const STOPS_LAYER_ID = "stops-layer";
const USER_SOURCE_ID = "user-location-source";
const USER_LAYER_ID = "user-location-layer";
const ROUTE_SOURCE_ID = "route-geometry-source";
const ROUTE_LAYER_ID = "route-geometry-layer";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

const BRAND_COLOR = "#0ea5e9";
const BRAND_SECONDARY = "#f43f5e"; 
const WALK_COLOR = "#94a3b8"; 

export function StopsMap({
  stops,
  selectedStopId,
  onSelectStop,
  nearbyStopIds,
  userLocation,
  followUser,
  selectedJourney,
  journeyGeometries,
  journeyNodes,
}: StopsMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const onSelectRef = useRef(onSelectStop);
  const hoverPopupRef = useRef<maplibregl.Popup | null>(null);

  useEffect(() => {
    onSelectRef.current = onSelectStop;
  }, [onSelectStop]);

  const upsertStopsLayer = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    const nearby = new Set(nearbyStopIds);
    const journeyStopIds = new Set<string>();
    if (selectedJourney) {
      for (const leg of selectedJourney.legs) {
        journeyStopIds.add(leg.fromStop.id);
        journeyStopIds.add(leg.toStop.id);
      }
    }

    const features = stops
      .filter((stop) => {
        if (stop.lat === undefined || stop.lon === undefined) return false;
        
        // Modo Viaje Activo: Ocultar todo el ruido gris, mostrar sólo los nodos clavo del viaje
        if (selectedJourney) {
          return journeyStopIds.has(stop.id);
        }

        // Modo Exploración: Mostrar cercanías y el nodo sleccionado
        if (nearby.size > 0 && !nearby.has(stop.id) && stop.id !== selectedStopId) return false;
        
        return true;
      })
      .map((stop) => ({
        type: "Feature" as const,
        properties: {
          id: stop.id,
          name: stop.name,
          lines: (stop.lines ?? []).join(", "),
          isNearby: nearby.has(stop.id),
          isJourneyNode: journeyStopIds.has(stop.id),
        },
        geometry: {
          type: "Point" as const,
          coordinates: [stop.lon as number, stop.lat as number],
        },
      }));

    const sourceData = { type: "FeatureCollection" as const, features };
    const source = map.getSource(STOPS_SOURCE_ID);
    if (source) {
      (source as maplibregl.GeoJSONSource).setData(sourceData);
    } else {
      map.addSource(STOPS_SOURCE_ID, { type: "geojson", data: sourceData });
      map.addLayer({
        id: STOPS_LAYER_ID,
        type: "circle",
        source: STOPS_SOURCE_ID,
        paint: {
          "circle-radius": [
            "case",
            ["==", ["get", "id"], selectedStopId ?? ""], 10,
            ["==", ["get", "isJourneyNode"], true], 8.5,
            ["==", ["get", "isNearby"], true], 6,
            4,
          ],
          "circle-color": [
            "case",
            ["==", ["get", "id"], selectedStopId ?? ""], "#f97316",
            ["==", ["get", "isJourneyNode"], true], "#10b981", 
            ["==", ["get", "isNearby"], true], "#cbd5e1",
            "#cbd5e1",
          ],
          "circle-opacity": [
            "case",
            ["==", ["get", "isJourneyNode"], true], 1,
            ["==", ["get", "id"], selectedStopId ?? ""], 1,
            0.6
          ],
          "circle-stroke-width": ["case", ["==", ["get", "isJourneyNode"], true], 2, ["==", ["get", "id"], selectedStopId ?? ""], 2.5, 1],
          "circle-stroke-color": "#ffffff",
        },
      });
      map.on("click", STOPS_LAYER_ID, (event) => {
        const id = event.features?.[0]?.properties?.id;
        if (typeof id === "string") onSelectRef.current(id);
      });
      map.on("mouseenter", STOPS_LAYER_ID, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", STOPS_LAYER_ID, () => { map.getCanvas().style.cursor = ""; hoverPopupRef.current?.remove(); });
    }

    if (map.getLayer(STOPS_LAYER_ID)) map.moveLayer(STOPS_LAYER_ID);
    if (map.getLayer(USER_LAYER_ID)) map.moveLayer(USER_LAYER_ID);
    
    map.setPaintProperty(STOPS_LAYER_ID, "circle-radius", ["case", ["==", ["get", "id"], selectedStopId ?? ""], 11, ["==", ["get", "isJourneyNode"], true], 9, ["==", ["get", "isNearby"], true], 6.5, 4]);
    map.setPaintProperty(STOPS_LAYER_ID, "circle-color", ["case", ["==", ["get", "id"], selectedStopId ?? ""], "#ef4444", ["==", ["get", "isJourneyNode"], true], "#10b981", "#cbd5e1"]);

  }, [nearbyStopIds, selectedStopId, stops, selectedJourney]);

  const upsertRouteLayer = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    const routeFeatures: any[] = [];
    
    if (selectedJourney && journeyNodes) {
      
      // 1. Caminata Origin -> Primera Parada
      const firstStop = selectedJourney.legs[0].fromStop;
      if (firstStop.lon !== undefined && firstStop.lat !== undefined) {
         routeFeatures.push({
           type: "Feature",
           properties: { isWalking: true },
           geometry: { type: "LineString", coordinates: [ [journeyNodes.origin.lng, journeyNodes.origin.lat], [firstStop.lon, firstStop.lat] ] }
         });
      }

      // 2. Piernas de Bus
      selectedJourney.legs.forEach((leg, index) => {
         const key = `${leg.lineId}_${leg.direction}`;
         const geomObj = journeyGeometries?.[key];
         console.log(`[StopsMap] geom check for ${key}:`, !!geomObj);
         if (geomObj && geomObj.features && geomObj.features.length > 0) {
           for (const feat of geomObj.features) {
             routeFeatures.push({ type: "Feature", properties: { legIndex: index }, geometry: feat.geometry });
           }
         } else {
           // Fallback: Linea recta si la API de geometria falla para Liferay
           if (leg.fromStop.lon !== undefined && leg.toStop.lon !== undefined) {
              routeFeatures.push({
                 type: "Feature",
                 properties: { legIndex: index, isFallback: true },
                 geometry: { type: "LineString", coordinates: [ [leg.fromStop.lon, leg.fromStop.lat], [leg.toStop.lon, leg.toStop.lat] ] }
              });
           }
         }

         // Caminata de trasbordo si corresponde
         if (index < selectedJourney.legs.length - 1) {
            const nextLeg = selectedJourney.legs[index + 1];
            if (leg.toStop.id !== nextLeg.fromStop.id && leg.toStop.lon !== undefined && nextLeg.fromStop.lon !== undefined) {
               routeFeatures.push({
                 type: "Feature",
                 properties: { isWalking: true },
                 geometry: { type: "LineString", coordinates: [ [leg.toStop.lon, leg.toStop.lat], [nextLeg.fromStop.lon, nextLeg.fromStop.lat] ] }
               });
            }
         }
      });

      // 3. Caminata Ultima Parada -> Destino
      const lastStop = selectedJourney.legs[selectedJourney.legs.length - 1].toStop;
      if (lastStop.lon !== undefined && lastStop.lat !== undefined) {
         routeFeatures.push({
           type: "Feature",
           properties: { isWalking: true },
           geometry: { type: "LineString", coordinates: [ [lastStop.lon, lastStop.lat], [journeyNodes.destination.lng, journeyNodes.destination.lat] ] }
         });
      }
    }

    const data = { type: "FeatureCollection" as const, features: routeFeatures };
    const source = map.getSource(ROUTE_SOURCE_ID);
    
    if (source) {
       (source as maplibregl.GeoJSONSource).setData(data);
    } else {
       map.addSource(ROUTE_SOURCE_ID, { type: "geojson", data });
       
       // Capa Sólida (Autobús)
       map.addLayer({
         id: ROUTE_LAYER_ID + "-solid",
         type: "line",
         source: ROUTE_SOURCE_ID,
         layout: { "line-join": "round", "line-cap": "round" },
         filter: ["!=", ["get", "isWalking"], true],
         paint: {
           "line-color": [
             "case",
             ["==", ["get", "legIndex"], 0], BRAND_COLOR,
             BRAND_SECONDARY
           ],
           "line-width": [
             "case",
             ["==", ["get", "isFallback"], true], 4,
             5
           ],
           "line-opacity": 0.85
         }
       }); 

       // Capa Punteada (Caminata Peatonal)
       map.addLayer({
         id: ROUTE_LAYER_ID + "-walk",
         type: "line",
         source: ROUTE_SOURCE_ID,
         layout: { "line-join": "round", "line-cap": "round" },
         filter: ["==", ["get", "isWalking"], true],
         paint: {
           "line-color": WALK_COLOR,
           "line-width": 4,
           "line-dasharray": [1, 2],
           "line-opacity": 0.8
         }
       }); 
    }
    
    if (routeFeatures.length > 0) {
       try {
           const bounds = new maplibregl.LngLatBounds();
           // Asegurarnos de encuadrar origin y dest!
           if (journeyNodes) {
             bounds.extend([journeyNodes.origin.lng, journeyNodes.origin.lat]);
             bounds.extend([journeyNodes.destination.lng, journeyNodes.destination.lat]);
           }
           routeFeatures.forEach(f => {
              if (f.geometry.type === "LineString") {
                 f.geometry.coordinates.forEach((c: any) => bounds.extend(c));
              }
           });
           if (!bounds.isEmpty()) {
              map.fitBounds(bounds, { padding: 40, duration: 800 });
           }
       } catch { } // ignora
    }
  }, [selectedJourney, journeyGeometries, journeyNodes]);

  const upsertUserLocation = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    
    // Si hay journeyNodes, pintamos el Destino. El Origen ya está como userLocation o es origin
    const nodes = [];
    if (userLocation) {
       nodes.push({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [userLocation.lng, userLocation.lat] }, properties: { type: "origin" } });
    }
    if (journeyNodes?.destination) {
       nodes.push({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [journeyNodes.destination.lng, journeyNodes.destination.lat] }, properties: { type: "dest" } });
    }

    const data = { type: "FeatureCollection" as const, features: nodes };
    const source = map.getSource(USER_SOURCE_ID);
    if (source) {
      (source as maplibregl.GeoJSONSource).setData(data);
    } else {
      map.addSource(USER_SOURCE_ID, { type: "geojson", data });
      map.addLayer({
        id: USER_LAYER_ID, type: "circle", source: USER_SOURCE_ID,
        paint: { 
           "circle-radius": 7, 
           "circle-color": ["case", ["==", ["get", "type"], "dest"], "#f43f5e", "#3b82f6"], 
           "circle-stroke-color": "#ffffff", 
           "circle-stroke-width": 3 
        },
      });
    }
  }, [followUser, userLocation, journeyNodes]);

  // Manejo de la Cámara Independiente del Paint de usuario
  const lastCenter = useRef<string | null>(null);
  useEffect(() => {
     if (!mapRef.current || !userLocation || selectedJourney) return;
     const centerKey = `${userLocation.lat},${userLocation.lng}`;
     if (followUser) {
        mapRef.current.flyTo({ center: [userLocation.lng, userLocation.lat], zoom: Math.max(mapRef.current.getZoom(), 15.5), speed: 0.6 });
        lastCenter.current = centerKey;
     } else if (lastCenter.current !== centerKey) {
        // Solo panear si la coordenada cambió mágicamente (Ej: click en 'Mi ubicacion') o es inicial
        mapRef.current.easeTo({ center: [userLocation.lng, userLocation.lat], zoom: 15.5, duration: 650 });
        lastCenter.current = centerKey;
     }
  }, [userLocation, followUser, selectedJourney]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({ container: containerRef.current, style: OSM_STYLE, center: [-8.73, 42.24], zoom: 12.5 });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    mapRef.current = map;

    map.on("load", () => {
      upsertStopsLayer();
      upsertRouteLayer();
      upsertUserLocation();

      map.on("mousemove", STOPS_LAYER_ID, (e) => {
        const feature = e.features?.[0]; if (!feature) return;
        const name = String(feature.properties?.name ?? "Parada");
        const id = String(feature.properties?.id ?? "?");
        if (!hoverPopupRef.current) hoverPopupRef.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "stop-hover-popup", offset: 12 });
        hoverPopupRef.current.setLngLat(e.lngLat).setHTML(`<div style="font-size:12px; font-family:sans-serif"><strong>${escapeHtml(name)}</strong><br/><span style="color:#666">ID: ${escapeHtml(id)}</span></div>`).addTo(map);
      });
    });

    return () => { hoverPopupRef.current?.remove(); map.remove(); mapRef.current = null; };
  }, [upsertStopsLayer, upsertUserLocation, upsertRouteLayer]);

  useEffect(() => { upsertStopsLayer(); }, [upsertStopsLayer, stops, nearbyStopIds, selectedStopId, selectedJourney]);
  useEffect(() => { upsertRouteLayer(); }, [upsertRouteLayer, selectedJourney, journeyGeometries, journeyNodes]);
  useEffect(() => { upsertUserLocation(); }, [upsertUserLocation]);

  return <div ref={containerRef} className="h-full min-h-[340px] w-full" />;
}
