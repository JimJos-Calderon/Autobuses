import type { BusStop, LiveArrival, LineGeometryFeatureCollection } from "@autobuses/shared";
import { Bus, Compass, Loader2, LocateFixed, MapPin } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchLiveByStopId, fetchNearbyStops, fetchStops, formatStopError } from "../api/stops";
import { fetchOfficialSequences, type OfficialSequenceRaw } from "../api/sequences";
import { fetchLineGeometry } from "../api/lines";
import { BusStopList } from "../components/BusStopList";
import { BusList } from "../components/BusList";
import { LocationSearchBar } from "../components/LocationSearchBar";
import { StopsMap } from "../components/StopsMap";
import { JourneyResults } from "../components/JourneyResults";
import { planJourney, type JourneyRoute } from "../utils/journeyPlanner";
import { useWatchLocation } from "../hooks/useWatchLocation";
import { haversineMeters } from "../utils/geo";

const LIVE_REFRESH_MS = 30_000;
const NEARBY_REFRESH_MS = 7_000;
const NEARBY_MIN_MOVEMENT_M = 20;

export function MainLayout() {
  const [stops, setStops] = useState<BusStop[]>([]);
  const [officialSequences, setOfficialSequences] = useState<OfficialSequenceRaw>({});
  
  const [selectedStop, setSelectedStop] = useState<BusStop | null>(null);
  const [arrivals, setArrivals] = useState<LiveArrival[]>([]);
  
  // Modos de Viaje
  const [destinationLoc, setDestinationLoc] = useState<{ lat: number; lng: number; name: string } | null>(null);
  const [journeyRoutes, setJourneyRoutes] = useState<JourneyRoute[]>([]);
  const [loadingJourney, setLoadingJourney] = useState(false);
  const [selectedJourney, setSelectedJourney] = useState<JourneyRoute | null>(null);
  const [journeyGeometries, setJourneyGeometries] = useState<Record<string, LineGeometryFeatureCollection>>({});

  // Estados Base
  const [loadingStops, setLoadingStops] = useState(true);
  const [loadingLive, setLoadingLive] = useState(false);
  const [refreshingLive, setRefreshingLive] = useState(false);
  const [liveMessage, setLiveMessage] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [travelMode, setTravelMode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [manualLocation, setManualLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [nearbyStopIds, setNearbyStopIds] = useState<string[]>([]);
  const lastNearbyQueryRef = useRef<{ lat: number; lng: number; at: number } | null>(null);

  const { location: watchedLocation, error: watchError } = useWatchLocation(travelMode);
  
  const originLoc = useMemo(
    () =>
      watchedLocation
        ? { lat: watchedLocation.lat, lng: watchedLocation.lng }
        : manualLocation,
    [manualLocation, watchedLocation],
  );

  useEffect(() => {
    if (!watchError) return;
    setError(watchError);
  }, [watchError]);

  useEffect(() => {
    let active = true;
    setLoadingStops(true);
    Promise.all([fetchStops(), fetchOfficialSequences()])
      .then(([stopsData, sequencesData]) => {
        if (!active) return;
        setStops(stopsData);
        setOfficialSequences(sequencesData);
      })
      .catch((e) => setError(formatStopError(e)))
      .finally(() => active && setLoadingStops(false));
    return () => { active = false; };
  }, []);

  // Planner
  useEffect(() => {
    if (!destinationLoc) {
      setJourneyRoutes([]);
      setSelectedJourney(null);
      return;
    }
    const effectiveOrigin = originLoc ?? { lat: 42.2328, lng: -8.7226 };
    setLoadingJourney(true);
    const timer = setTimeout(() => {
      const routes = planJourney(effectiveOrigin, destinationLoc, stops, officialSequences);
      setJourneyRoutes(routes);
      setLoadingJourney(false);
    }, 100);
    return () => clearTimeout(timer);
  }, [destinationLoc, originLoc, stops, officialSequences]);

  // Highlight Geometrías de Viaje Seleccionado
  useEffect(() => {
    if (!selectedJourney) {
      setJourneyGeometries({});
      return;
    }
    let active = true;
    const fetchGeoms = async () => {
      const geoms: Record<string, LineGeometryFeatureCollection> = {};
      for (const leg of selectedJourney.legs) {
        if (leg.direction === "?") continue; // Si es Fuzzy no tenemos un sentido claro para pedir geometría
        const key = `${leg.lineId}_${leg.direction}`;
        try {
          const g = await fetchLineGeometry(leg.lineId, leg.direction);
          if (g && active) geoms[key] = g;
        } catch { /* ignorar si falla una línea partícular */ }
      }
      if (active) setJourneyGeometries(geoms);
    };
    void fetchGeoms();
    return () => { active = false; };
  }, [selectedJourney]);

  useEffect(() => {
    if (!selectedStop) return;
    let active = true;
    const applyLiveResponse = (data: { arrivals: LiveArrival[]; isTheoretical: boolean; message?: string }) => {
      setArrivals([...data.arrivals].sort((a, b) => a.tiempo_minutos - b.tiempo_minutos));
      setLiveMessage(data.message ?? null);
    };

    const loadLive = async () => {
      setLoadingLive(true);
      setError(null);
      setLiveMessage(null);
      try {
        const data = await fetchLiveByStopId(selectedStop.id);
        if (active) applyLiveResponse(data);
      } catch (e) {
        if (active) {
          setArrivals([]);
          setLiveMessage(null);
          setError(formatStopError(e));
        }
      } finally {
        if (active) setLoadingLive(false);
      }
    };

    void loadLive();
    const refresh = window.setInterval(() => {
      if (!active) return;
      setRefreshingLive(true);
      fetchLiveByStopId(selectedStop.id)
        .then(data => active && applyLiveResponse(data))
        .catch(() => {})
        .finally(() => active && setRefreshingLive(false));
    }, LIVE_REFRESH_MS);
    return () => { active = false; window.clearInterval(refresh); };
  }, [selectedStop]);

  const refreshNearbyStops = useCallback((lat: number, lng: number, opts?: { force?: boolean }) => {
    const now = Date.now();
    const last = lastNearbyQueryRef.current;
    const moved = last ? haversineMeters(lat, lng, last.lat, last.lng) : Number.POSITIVE_INFINITY;
    const elapsed = last ? now - last.at : Number.POSITIVE_INFINITY;
    if (!opts?.force && (moved < NEARBY_MIN_MOVEMENT_M || elapsed < NEARBY_REFRESH_MS)) return;
    lastNearbyQueryRef.current = { lat, lng, at: now };
    void fetchNearbyStops(lat, lng)
      .then((n) => setNearbyStopIds(n.slice(0, 15).map((s) => s.id)))
      .catch((e) => setError(formatStopError(e)));
  }, []);

  const locateMe = useCallback(() => {
    if (!navigator.geolocation) {
      setError("Geolocalización no soportada.");
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setManualLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        refreshNearbyStops(pos.coords.latitude, pos.coords.longitude, { force: true });
        setLocating(false);
      },
      () => {
        setLocating(false);
        setError("Denegado. Usa el modo manual.");
      },
      { enableHighAccuracy: true, timeout: 10_000 }
    );
  }, [refreshNearbyStops]);

  useEffect(() => {
    if (originLoc) refreshNearbyStops(originLoc.lat, originLoc.lng);
  }, [originLoc, refreshNearbyStops]);

  const nearbyStopsContent = useMemo(() => {
    return nearbyStopIds
      .map(id => stops.find(s => s.id === id))
      .filter((s): s is BusStop => s !== undefined);
  }, [nearbyStopIds, stops]);

  return (
    <div className="min-h-[100dvh] bg-[var(--color-app-bg)] text-slate-900 overflow-hidden flex flex-col">
      <header className="border-b border-slate-200 bg-white/90 backdrop-blur shrink-0 z-20">
        <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-4 py-4">
          <Bus className="h-7 w-7 text-[var(--color-brand)]" aria-hidden />
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Vigo Transit Pro</h1>
            <p className="text-xs text-[var(--color-app-muted)]">
              {destinationLoc ? "Modo Viaje Matemático" : "Radar de Proximidad"}
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1400px] w-full flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-[1.4fr_1fr] h-full overflow-hidden">
        
        <section className="relative overflow-hidden rounded-2xl border border-slate-200 bg-slate-100 shadow-sm flex flex-col h-[50dvh] lg:h-auto z-0">
          <div className="flex gap-2 border-b border-slate-200/60 bg-white/80 backdrop-blur absolute top-0 left-0 right-0 z-10 p-3 shadow-none">
            <button type="button" onClick={locateMe} className="inline-flex shadow-sm items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition">
              <LocateFixed className={`h-4 w-4 ${locating ? "animate-spin" : ""}`} /> Mi ubicación
            </button>
            <button type="button" onClick={() => setTravelMode((v) => !v)} className={`inline-flex shadow-sm items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition ${travelMode ? "border-[var(--color-brand)] bg-[var(--color-brand-soft)] text-[var(--color-brand)]" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>
              <Compass className={`h-4 w-4 ${travelMode ? "animate-spin" : ""}`} />
              Seguimiento
            </button>
          </div>
          <StopsMap
            stops={stops}
            selectedStopId={selectedStop?.id ?? null}
            onSelectStop={(stopId) => {
              const match = stops.find((s) => s.id === stopId);
              if (match) setSelectedStop(match);
            }}
            nearbyStopIds={nearbyStopIds}
            userLocation={originLoc ?? { lat: 42.2328, lng: -8.7226 }} // Siempre mostramos el origen del cálculo
            followUser={travelMode}
            selectedJourney={selectedJourney}
            journeyGeometries={journeyGeometries}
            journeyNodes={selectedJourney && destinationLoc ? { 
               origin: originLoc ?? { lat: 42.2328, lng: -8.7226 }, 
               destination: destinationLoc 
            } : null}
          />
        </section>

        <aside className="flex flex-col gap-4 overflow-y-auto pb-8 lg:pb-0 hide-scrollbar z-10">
          <div className="relative rounded-2xl border border-slate-200 bg-white p-4 shadow-sm shrink-0">
             {!destinationLoc ? (
               <LocationSearchBar onLocationSelect={(lat, lon, name) => setDestinationLoc({ lat, lng: lon, name })} loadingLocation={loadingJourney} />
             ) : (
               <div className="flex flex-col gap-2">
                 <div className="flex items-center gap-3">
                   <div className="flex flex-col items-center justify-center mt-1">
                      <div className="h-2 w-2 bg-slate-400 rounded-full" />
                      <div className="w-[1.5px] h-6 bg-slate-200" />
                      <div className="h-2 w-2 bg-rose-500 rounded-full ring-2 ring-rose-100" />
                   </div>
                   <div className="flex-1 flex flex-col gap-2">
                     <span className="text-sm text-slate-500 font-medium px-2">Mi ubicación</span>
                     <div className="flex justify-between items-center bg-rose-50 border border-rose-100 px-3 py-2 rounded-lg">
                       <span className="text-sm text-rose-700 font-bold truncate pr-3">{destinationLoc.name}</span>
                       <button onClick={() => {setDestinationLoc(null); setSelectedJourney(null);}} className="text-rose-500 hover:text-rose-700 text-xs font-bold uppercase">Limpiar</button>
                     </div>
                   </div>
                 </div>
               </div>
             )}
          </div>

          {!destinationLoc ? (
            <BusStopList
              title="Explorar Alrededores"
              subtitle={`${nearbyStopsContent.length} paradas cerca`}
              stops={nearbyStopsContent.map(s => ({ stop: s }))}
              loading={loadingStops}
              selectedStopId={selectedStop?.id ?? null}
              onSelectStop={setSelectedStop}
              emptyMessage="Sin resultados de proximidad."
              transitionKey="scan"
            />
          ) : (
            <section className="rounded-2xl border border-slate-200 bg-white p-1 shadow-sm">
              <JourneyResults 
                routes={journeyRoutes} 
                loading={loadingJourney} 
                onSelectRoute={(r) => {
                  setSelectedJourney(r);
                  if (r.legs[0]?.fromStop) setSelectedStop(r.legs[0].fromStop);
                }}
              />
            </section>
          )}

          {((selectedStop && destinationLoc) || (!destinationLoc && selectedStop)) && (
            <section className="rounded-2xl border border-slate-200 bg-slate-900 border-slate-800 p-4 shadow-lg shrink-0 animate-in fade-in relative z-20">
              <div className="mb-2 flex items-start gap-2 text-white justify-between">
                <div className="flex items-start gap-2">
                  <MapPin className="h-5 w-5 text-emerald-400" />
                  <div>
                    <p className="text-sm font-bold">{selectedStop.name}</p>
                    <p className="text-xs text-slate-400 mt-0.5">Tiempos en Vivo API</p>
                  </div>
                </div>
                {refreshingLive && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
              </div>
              
              {liveMessage && <p className="mb-3 rounded-lg border border-amber-900/50 bg-amber-900/20 px-3 py-2 text-xs text-amber-200">{liveMessage}</p>}
              {error && <p className="mb-3 rounded-lg border border-red-900/50 bg-red-900/20 px-3 py-2 text-xs text-red-200">{error}</p>}
              {loadingLive && !refreshingLive && <p className="mb-3 text-xs text-slate-500">Actualizando...</p>}

              <div className="max-h-[35vh] overflow-y-auto mt-3 border-t border-slate-700/50 pt-2">
                <BusList arrivals={arrivals} colorByLine={{}} />
              </div>
            </section>
          )}
        </aside>
      </main>
    </div>
  );
}
