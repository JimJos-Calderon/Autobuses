import type {
  BusStop,
  LineGeometryFeatureCollection,
  LineSummary,
  LiveArrival,
  NearbyBusStop,
} from "@autobuses/shared";
import { Bus, Compass, Loader2, LocateFixed, MapPin, Route, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchLineGeometry, fetchLines } from "../api/lines";
import {
  fetchLiveByStopId,
  fetchNearbyStops,
  fetchStops,
  formatStopError,
} from "../api/stops";
import { BusList } from "../components/BusList";
import { LineSearchBar } from "../components/LineSearchBar";
import { StopsMap } from "../components/StopsMap";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useWatchLocation } from "../hooks/useWatchLocation";
import { haversineMeters } from "../utils/geo";

const MAX_VISIBLE_STOPS = 25;
const NEARBY_REFRESH_MS = 7_000;
const NEARBY_MIN_MOVEMENT_M = 20;

export function MainLayout() {
  const [stops, setStops] = useState<BusStop[]>([]);
  const [selectedStop, setSelectedStop] = useState<BusStop | null>(null);
  const [arrivals, setArrivals] = useState<LiveArrival[]>([]);
  const [query, setQuery] = useState("");
  const [loadingStops, setLoadingStops] = useState(true);
  const [loadingLive, setLoadingLive] = useState(false);
  const [locating, setLocating] = useState(false);
  const [travelMode, setTravelMode] = useState(false);

  const [lines, setLines] = useState<LineSummary[]>([]);
  const [selectedLine, setSelectedLine] = useState<LineSummary | null>(null);
  const [selectedLineGeometry, setSelectedLineGeometry] =
    useState<LineGeometryFeatureCollection | null>(null);
  const [loadingLines, setLoadingLines] = useState(true);
  const [loadingLineGeometry, setLoadingLineGeometry] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [manualLocation, setManualLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [nearbyStopIds, setNearbyStopIds] = useState<string[]>([]);

  const { location: watchedLocation, error: watchError } = useWatchLocation(travelMode);
  const effectiveLocation = watchedLocation
    ? { lat: watchedLocation.lat, lng: watchedLocation.lng }
    : manualLocation;

  const lastNearbyQueryRef = useRef<{ lat: number; lng: number; at: number } | null>(null);

  const debouncedQuery = useDebouncedValue(query, 250);
  const selectedLineColor = selectedLine?.color ?? "#475569";

  useEffect(() => {
    if (!watchError) return;
    setError(watchError);
  }, [watchError]);

  const lineColorById = useMemo(() => {
    const out: Record<string, string> = {};
    for (const line of lines) out[line.id.toUpperCase()] = line.color;
    return out;
  }, [lines]);

  const lineFilteredStopIds = useMemo(() => {
    if (!selectedLine) return [];
    const lineId = selectedLine.id.toUpperCase();
    return stops
      .filter((stop) => (stop.lines ?? []).some((id) => id.toUpperCase() === lineId))
      .map((stop) => stop.id);
  }, [selectedLine, stops]);

  const lineFilterActive = selectedLine !== null;
  const stopInSelectedLine =
    selectedStop !== null &&
    selectedLine !== null &&
    (selectedStop.lines ?? []).some((id) => id.toUpperCase() === selectedLine.id.toUpperCase());

  useEffect(() => {
    let active = true;
    setLoadingStops(true);
    void fetchStops()
      .then((data) => {
        if (!active) return;
        setStops(data);
        if (data.length > 0) setSelectedStop(data[0]);
      })
      .catch((e) => {
        if (!active) return;
        setError(formatStopError(e));
      })
      .finally(() => {
        if (active) setLoadingStops(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setLoadingLines(true);
    void fetchLines()
      .then((data) => {
        if (!active) return;
        setLines(data);
      })
      .catch((e) => {
        if (!active) return;
        setError(formatStopError(e));
      })
      .finally(() => {
        if (active) setLoadingLines(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedStop) return;
    let active = true;
    setLoadingLive(true);
    setError(null);
    void fetchLiveByStopId(selectedStop.id)
      .then((data) => {
        if (!active) return;
        const sorted = [...data].sort((a, b) => a.tiempo_minutos - b.tiempo_minutos);
        setArrivals(sorted);
      })
      .catch((e) => {
        if (!active) return;
        setArrivals([]);
        setError(formatStopError(e));
      })
      .finally(() => {
        if (active) setLoadingLive(false);
      });

    const refresh = window.setInterval(() => {
      void fetchLiveByStopId(selectedStop.id)
        .then((data) => {
          if (!active) return;
          const sorted = [...data].sort((a, b) => a.tiempo_minutos - b.tiempo_minutos);
          setArrivals(sorted);
        })
        .catch(() => {
          if (!active) return;
          setArrivals([]);
        });
    }, 30_000);

    return () => {
      active = false;
      window.clearInterval(refresh);
    };
  }, [selectedStop]);

  const refreshNearbyStops = useCallback(
    (lat: number, lng: number, opts?: { force?: boolean }) => {
      const now = Date.now();
      const last = lastNearbyQueryRef.current;
      const moved = last ? haversineMeters(lat, lng, last.lat, last.lng) : Number.POSITIVE_INFINITY;
      const elapsed = last ? now - last.at : Number.POSITIVE_INFINITY;

      const force = opts?.force === true;
      if (!force && (moved < NEARBY_MIN_MOVEMENT_M || elapsed < NEARBY_REFRESH_MS)) return;

      lastNearbyQueryRef.current = { lat, lng, at: now };
      void fetchNearbyStops(lat, lng)
        .then((nearby: NearbyBusStop[]) => {
          const topThree = nearby.slice(0, 3);
          setNearbyStopIds(topThree.map((stop) => stop.id));
          if (topThree[0]) {
            const match = stops.find((stop) => stop.id === topThree[0].id);
            if (match) setSelectedStop(match);
          }
        })
        .catch((e) => setError(formatStopError(e)));
    },
    [stops],
  );

  useEffect(() => {
    if (!travelMode || !effectiveLocation) return;
    refreshNearbyStops(effectiveLocation.lat, effectiveLocation.lng);
  }, [effectiveLocation, refreshNearbyStops, travelMode]);

  const filteredStops = useMemo(() => {
    const q = debouncedQuery.trim().toLocaleLowerCase("es-ES");
    if (!q) return stops.slice(0, MAX_VISIBLE_STOPS);
    return stops
      .filter((stop) => {
        const name = stop.name.toLocaleLowerCase("es-ES");
        return name.includes(q) || stop.id.includes(q);
      })
      .slice(0, MAX_VISIBLE_STOPS);
  }, [debouncedQuery, stops]);

  const stopLines = useMemo(() => {
    if (!selectedStop) return [];
    return (selectedStop.lines ?? []).map((id) => ({
      id,
      color: lineColorById[id.toUpperCase()] ?? "#475569",
    }));
  }, [lineColorById, selectedStop]);

  const selectLine = (line: LineSummary) => {
    setSelectedLine(line);
    setLoadingLineGeometry(true);
    setError(null);
    void fetchLineGeometry(line.id)
      .then((geo) => setSelectedLineGeometry(geo))
      .catch((e) => {
        setSelectedLineGeometry(null);
        setError(formatStopError(e));
      })
      .finally(() => setLoadingLineGeometry(false));
  };

  const locateMe = () => {
    if (!navigator.geolocation) {
      setError("Geolocalizacion no disponible en este navegador.");
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        setManualLocation({ lat, lng });
        refreshNearbyStops(lat, lng, { force: true });
        setLocating(false);
      },
      () => {
        setLocating(false);
        setError("No se pudo obtener tu ubicacion.");
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 20_000 },
    );
  };

  return (
    <div className="min-h-full bg-[var(--color-app-bg)] text-slate-900">
      <header className="border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-4 py-4">
          <Bus className="h-7 w-7 text-[var(--color-brand)]" aria-hidden />
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Bus Vigo Dashboard</h1>
            <p className="text-xs text-[var(--color-app-muted)]">
              Navegacion urbana en tiempo real
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1400px] grid-cols-1 gap-4 p-4 lg:grid-cols-[1.4fr_0.9fr]">
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex gap-2 border-b border-slate-100 p-3">
            <button
              type="button"
              onClick={locateMe}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <LocateFixed className={`h-4 w-4 ${locating ? "animate-spin" : ""}`} />
              Mi ubicacion
            </button>
            <button
              type="button"
              onClick={() => setTravelMode((v) => !v)}
              className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium ${
                travelMode
                  ? "border-[var(--color-brand)] bg-[var(--color-brand-soft)] text-[var(--color-brand)]"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              <Compass className={`h-4 w-4 ${travelMode ? "animate-spin" : ""}`} />
              Modo Viaje
            </button>
          </div>
          <div className="h-[55vh] min-h-[380px]">
            <StopsMap
              stops={stops}
              selectedStopId={selectedStop?.id ?? null}
              onSelectStop={(stopId) => {
                const match = stops.find((stop) => stop.id === stopId);
                if (match) setSelectedStop(match);
              }}
              selectedLineGeometry={selectedLineGeometry}
              selectedLineColor={selectedLineColor}
              lineFilterActive={lineFilterActive}
              lineFilteredStopIds={lineFilteredStopIds}
              nearbyStopIds={nearbyStopIds}
              userLocation={effectiveLocation}
              followUser={travelMode}
            />
          </div>
        </section>

        <aside className="grid gap-4">
          <LineSearchBar
            lines={lines}
            loading={loadingLines}
            selectedLineId={selectedLine?.id ?? null}
            onSelectLine={selectLine}
          />

          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div
              className={`flex items-center justify-between rounded-lg border px-3 py-2 transition-opacity duration-500 ${
                selectedLine ? "opacity-100" : "opacity-0"
              } ${selectedLine ? "border-slate-200" : "pointer-events-none border-transparent"}`}
            >
              <div className="flex items-center gap-2">
                <Route className="h-4 w-4" style={{ color: selectedLineColor }} />
                <div className="text-sm">
                  <span className="font-semibold">{selectedLine?.id ?? "-"}</span>
                  <span className="ml-2 text-slate-600">
                    {selectedLine?.destination ??
                      selectedLine?.friendlyName ??
                      selectedLine?.name ??
                      ""}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedLine(null);
                  setSelectedLineGeometry(null);
                }}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                <X className="h-3.5 w-3.5" />
                Limpiar recorrido
              </button>
            </div>
            {loadingLineGeometry && (
              <p className="mt-2 text-xs text-slate-500">Cargando recorrido...</p>
            )}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
              Buscar parada
            </label>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ID o nombre"
              className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none ring-[var(--color-brand)] focus:ring-2"
            />
            <div className="mt-3 max-h-52 overflow-y-auto">
              {loadingStops && (
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Cargando paradas...
                </div>
              )}
              {!loadingStops && filteredStops.length === 0 && (
                <p className="text-sm text-slate-500">No hay coincidencias.</p>
              )}
              {!loadingStops && (
                <ul className="grid gap-2">
                  {filteredStops.map((stop) => (
                    <li key={stop.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedStop(stop)}
                        className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition ${
                          selectedStop?.id === stop.id
                            ? "border-[var(--color-brand)] bg-[var(--color-brand-soft)]"
                            : "border-slate-200 hover:bg-slate-50"
                        }`}
                      >
                        <span className="font-semibold">{stop.id}</span>
                        <span className="ml-2 text-slate-600">{stop.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <MapPin className="mt-0.5 h-4 w-4 text-[var(--color-brand)]" aria-hidden />
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-slate-900">
                      {selectedStop?.name ?? "Selecciona una parada"}
                    </p>
                    {stopInSelectedLine && (
                      <span className="relative inline-flex h-2.5 w-2.5">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500">ID {selectedStop?.id ?? "-"}</p>
                </div>
              </div>
              {loadingLive && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
            </div>

            {stopLines.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {stopLines.map((line) => (
                  <span
                    key={line.id}
                    className="inline-flex items-center gap-2 rounded-full border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700"
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: line.color }}
                    />
                    {line.id}
                  </span>
                ))}
              </div>
            )}

            {error && (
              <p className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
                {error}
              </p>
            )}
            <BusList arrivals={arrivals} colorByLine={lineColorById} />
          </section>
        </aside>
      </main>
    </div>
  );
}
