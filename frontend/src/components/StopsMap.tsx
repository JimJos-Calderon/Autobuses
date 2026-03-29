import type { BusStop, LineGeometryFeatureCollection } from "@autobuses/shared";
import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from "maplibre-gl";
import { useCallback, useEffect, useRef } from "react";

interface StopsMapProps {
  stops: BusStop[];
  selectedStopId: string | null;
  onSelectStop: (stopId: string) => void;
  selectedLineGeometry: LineGeometryFeatureCollection | null;
  selectedLineColor: string;
  lineFilterActive: boolean;
  lineFilteredStopIds: string[];
  nearbyStopIds: string[];
  userLocation: { lat: number; lng: number } | null;
  followUser: boolean;
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
const ROUTE_SOURCE_ID = "route-source";
const ROUTE_LAYER_ID = "route-layer";
const ROUTE_ARROWS_LAYER_ID = "route-arrows-layer";
const USER_SOURCE_ID = "user-location-source";
const USER_LAYER_ID = "user-location-layer";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function StopsMap({
  stops,
  selectedStopId,
  onSelectStop,
  selectedLineGeometry,
  selectedLineColor,
  lineFilterActive,
  lineFilteredStopIds,
  nearbyStopIds,
  userLocation,
  followUser,
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

    const filtered = new Set(lineFilteredStopIds);
    const nearby = new Set(nearbyStopIds);
    const features = stops
      .filter((stop) => stop.lat !== undefined && stop.lon !== undefined)
      .map((stop) => ({
        type: "Feature" as const,
        properties: {
          id: stop.id,
          name: stop.name,
          lines: (stop.lines ?? []).join(", "),
          isOnLine: filtered.has(stop.id),
          isNearby: nearby.has(stop.id),
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
            ["==", ["get", "id"], selectedStopId ?? ""],
            9,
            ["==", ["get", "isNearby"], true],
            7.5,
            5,
          ],
          "circle-color": [
            "case",
            ["==", ["get", "id"], selectedStopId ?? ""],
            "#f97316",
            ["==", ["get", "isNearby"], true],
            "#f59e0b",
            "#2563eb",
          ],
          "circle-opacity": lineFilterActive
            ? [
                "case",
                ["==", ["get", "isOnLine"], true],
                1,
                0,
              ]
            : 0.9,
          "circle-stroke-width": [
            "case",
            ["==", ["get", "isNearby"], true],
            2,
            1.25,
          ],
          "circle-stroke-color": "#ffffff",
        },
      });

      map.on("click", STOPS_LAYER_ID, (event) => {
        const id = event.features?.[0]?.properties?.id;
        if (typeof id === "string") onSelectRef.current(id);
      });
      map.on("mouseenter", STOPS_LAYER_ID, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mousemove", STOPS_LAYER_ID, (event) => {
        const feature = event.features?.[0];
        if (!feature) return;
        const name = String(feature.properties?.name ?? "Parada");
        const lines = String(feature.properties?.lines ?? "");
        const html = `<div style="font-size:12px"><strong>${escapeHtml(name)}</strong><br/>Lineas: ${escapeHtml(lines || "-")}</div>`;

        if (!hoverPopupRef.current) {
          hoverPopupRef.current = new maplibregl.Popup({
            closeButton: false,
            closeOnClick: false,
            className: "stop-hover-popup",
            offset: 12,
          });
        }
        hoverPopupRef.current
          .setLngLat(event.lngLat)
          .setHTML(html)
          .addTo(map);
      });
      map.on("mouseleave", STOPS_LAYER_ID, () => {
        map.getCanvas().style.cursor = "";
        hoverPopupRef.current?.remove();
      });
    }

    map.setPaintProperty(STOPS_LAYER_ID, "circle-radius", [
      "case",
      ["==", ["get", "id"], selectedStopId ?? ""],
      9,
      ["==", ["get", "isNearby"], true],
      7.5,
      5,
    ]);
    map.setPaintProperty(STOPS_LAYER_ID, "circle-color", [
      "case",
      ["==", ["get", "id"], selectedStopId ?? ""],
      "#f97316",
      ["==", ["get", "isNearby"], true],
      "#f59e0b",
      "#2563eb",
    ]);
    map.setPaintProperty(
      STOPS_LAYER_ID,
      "circle-opacity",
      lineFilterActive
        ? [
            "case",
            ["==", ["get", "isOnLine"], true],
            1,
            0,
          ]
        : 0.9,
    );
    map.setPaintProperty(STOPS_LAYER_ID, "circle-stroke-width", [
      "case",
      ["==", ["get", "isNearby"], true],
      2,
      1.25,
    ]);
    map.setFilter(
      STOPS_LAYER_ID,
      lineFilterActive ? ["==", ["get", "isOnLine"], true] : null,
    );
  }, [lineFilterActive, lineFilteredStopIds, nearbyStopIds, selectedStopId, stops]);

  const clearRoute = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    if (map.getLayer(ROUTE_ARROWS_LAYER_ID)) map.removeLayer(ROUTE_ARROWS_LAYER_ID);
    if (map.getLayer(ROUTE_LAYER_ID)) map.removeLayer(ROUTE_LAYER_ID);
    if (map.getSource(ROUTE_SOURCE_ID)) map.removeSource(ROUTE_SOURCE_ID);
  }, []);

  const drawRoute = useCallback((geoData: LineGeometryFeatureCollection, color: string) => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    const source = map.getSource(ROUTE_SOURCE_ID);
    if (source) {
      (source as maplibregl.GeoJSONSource).setData(geoData);
    } else {
      map.addSource(ROUTE_SOURCE_ID, { type: "geojson", data: geoData });
      map.addLayer({
        id: ROUTE_LAYER_ID,
        type: "line",
        source: ROUTE_SOURCE_ID,
        paint: {
          "line-color": color,
          "line-width": 4,
          "line-opacity": 0,
          "line-opacity-transition": { duration: 420, delay: 0 },
        },
      });
      map.addLayer({
        id: ROUTE_ARROWS_LAYER_ID,
        type: "symbol",
        source: ROUTE_SOURCE_ID,
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": 42,
          "text-field": ">",
          "text-size": 10,
          "text-keep-upright": false,
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": color,
          "text-opacity": 0.8,
        },
      });
    }

    map.setPaintProperty(ROUTE_LAYER_ID, "line-color", color);
    map.setPaintProperty(ROUTE_LAYER_ID, "line-width", 4);
    map.setPaintProperty(ROUTE_LAYER_ID, "line-opacity", 1);
    map.setPaintProperty(ROUTE_ARROWS_LAYER_ID, "text-color", color);

    const bounds = new maplibregl.LngLatBounds();
    for (const feature of geoData.features) {
      for (const [lon, lat] of feature.geometry.coordinates) bounds.extend([lon, lat]);
    }
    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, { padding: 50, duration: 550, maxZoom: 15.5 });
    }
  }, []);

  const upsertUserLocation = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || !userLocation) return;
    const data = {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          geometry: {
            type: "Point" as const,
            coordinates: [userLocation.lng, userLocation.lat],
          },
          properties: {},
        },
      ],
    };

    const source = map.getSource(USER_SOURCE_ID);
    if (source) {
      (source as maplibregl.GeoJSONSource).setData(data);
    } else {
      map.addSource(USER_SOURCE_ID, { type: "geojson", data });
      map.addLayer({
        id: USER_LAYER_ID,
        type: "circle",
        source: USER_SOURCE_ID,
        paint: {
          "circle-radius": 8,
          "circle-color": "#14b8a6",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
    }

    if (followUser) {
      map.flyTo({
        center: [userLocation.lng, userLocation.lat],
        zoom: Math.max(map.getZoom(), 14.5),
        speed: 0.6,
        curve: 1.35,
        essential: true,
      });
    } else {
      map.easeTo({ center: [userLocation.lng, userLocation.lat], zoom: 14.5, duration: 650 });
    }
  }, [followUser, userLocation]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: OSM_STYLE,
      center: [-8.73, 42.24],
      zoom: 12.5,
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    mapRef.current = map;

    map.on("load", () => {
      upsertStopsLayer();
      upsertUserLocation();
      if (selectedLineGeometry) drawRoute(selectedLineGeometry, selectedLineColor);
    });

    return () => {
      hoverPopupRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    upsertStopsLayer();
  }, [upsertStopsLayer]);

  useEffect(() => {
    if (!selectedLineGeometry) {
      clearRoute();
      return;
    }
    drawRoute(selectedLineGeometry, selectedLineColor);
  }, [clearRoute, drawRoute, selectedLineColor, selectedLineGeometry]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || !lineFilterActive || lineFilteredStopIds.length === 0) {
      return;
    }

    const allowed = new Set(lineFilteredStopIds);
    const bounds = new maplibregl.LngLatBounds();
    for (const stop of stops) {
      if (!allowed.has(stop.id)) continue;
      if (stop.lat === undefined || stop.lon === undefined) continue;
      bounds.extend([stop.lon, stop.lat]);
    }
    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, { padding: 50, duration: 550, maxZoom: 15.5 });
    }
  }, [lineFilterActive, lineFilteredStopIds, stops]);

  useEffect(() => {
    upsertUserLocation();
  }, [upsertUserLocation]);

  return <div ref={containerRef} className="h-full min-h-[340px] w-full" />;
}
