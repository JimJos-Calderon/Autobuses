import { Clock, MapPin, Footprints, Bus as BusIcon, ChevronRight, AlertTriangle, GitMerge } from "lucide-react";
import { useEffect, useState } from "react";
import type { JourneyRoute } from "../utils/journeyPlanner";
import { fetchLiveByStopId } from "../api/stops";

interface JourneyResultsProps {
  routes: JourneyRoute[];
  onSelectRoute?: (route: JourneyRoute) => void;
  loading: boolean;
}

// Subcomponente individual para cachear su propio Live Status y auto-actualizarse
function RouteCard({ route, onSelect }: { route: JourneyRoute; onSelect: () => void }) {
  const [liveMins, setLiveMins] = useState<number | null>(null);
  
  useEffect(() => {
    let active = true;
    const firstLeg = route.legs[0];
    if (!firstLeg || route.type.startsWith("FUZZY")) return; // Los Fuzzy a veces tienen de origen puntos abstractos sin StopID fiable o no sabemos el sentido
    
    fetchLiveByStopId(firstLeg.fromStop.id)
      .then(data => {
        if (!active) return;
        // Buscar el próximo bus para la linea de la primera pierna
        const targetLines = route.type === "FUZZY" ? firstLeg.fromStop.lines : [firstLeg.lineId];
        const nextBus = data.arrivals.find(a => (targetLines ?? []).map(l => l.toUpperCase()).includes(a.linea.toUpperCase()));
        if (nextBus) {
          setLiveMins(nextBus.tiempo_minutos);
        }
      })
      .catch(() => {});
      
    return () => { active = false; };
  }, [route]);

  // Si tenemos live arrival, el tiempo total es el estimado - el tiempo puramente caminando + la espera real
  const finalMinutes = liveMins !== null 
    ? route.estimatedMinutes + liveMins 
    : route.estimatedMinutes;

  const isFuzzy = route.type.startsWith("FUZZY");
  const isTransfer = route.type.includes("TRANSFER");

  return (
    <button
      onClick={onSelect}
      className={`flex w-full cursor-pointer flex-col gap-3 rounded-2xl border bg-white p-4 text-left shadow-sm transition hover:shadow-md focus:outline-none ${
        isFuzzy ? "border-amber-200" : "border-slate-200 hover:border-[var(--color-brand)]"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${
          liveMins !== null 
            ? "bg-emerald-500 text-white shadow-sm ring-1 ring-emerald-600/50 blink-live" 
            : "bg-slate-100 text-slate-700"
        }`}>
          <Clock className="h-3.5 w-3.5" />
          ~{finalMinutes} min {liveMins !== null && "(En tiempo real)"}
        </span>
        <span className={`hidden sm:inline text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${
          isFuzzy ? "bg-amber-50 text-amber-600" : "bg-[var(--color-brand-soft)] text-[var(--color-brand)]"
        }`}>
          {route.type.replace("-DIRECT", "").replace("-TRANSFER", "")} {isTransfer && "TRASBORDO"}
        </span>
      </div>

      <div className="mt-1 flex flex-col gap-2 relative">
        <div className="absolute left-[11px] top-4 bottom-4 w-px bg-slate-200" />
        
        {/* Origen -> Primera Parada */}
        <div className="flex items-center gap-3 relative z-10">
          <div className="bg-white rounded-full p-[2px]">
            <Footprints className="h-5 w-5 text-slate-400 p-0.5" />
          </div>
          <div className="text-sm text-slate-600 font-medium">
             Caminar a <span className="text-slate-900">{route.legs[0].fromStop.name}</span>
          </div>
        </div>

        {/* Piernas de Bus */}
        {route.legs.map((leg, idx) => (
          <div key={idx} className="flex flex-col gap-2">
            <div className="flex items-center gap-3 relative z-10 my-1">
              <div className="bg-white rounded-full p-[2px] shadow-sm ring-1 ring-slate-100">
                <div className="h-5 w-5 rounded-full bg-slate-800 text-white flex items-center justify-center">
                  <BusIcon className="h-3 w-3" />
                </div>
              </div>
              <div className="flex-1 text-sm font-medium text-slate-900 flex items-center gap-2 flex-wrap">
                <span className={`font-bold ${isFuzzy ? "text-amber-500" : "text-[var(--color-brand)]"}`}>{leg.lineId.toUpperCase()}</span>
                {leg.direction && leg.direction !== "?" && (
                  <span className="text-[10px] font-bold text-slate-500 uppercase bg-slate-100 px-1.5 py-[1px] rounded">
                    {leg.direction}
                  </span>
                )}
                <ChevronRight className="h-3.5 w-3.5 text-slate-300" />
                <span className="text-slate-600 font-normal text-xs">{leg.numStops} paradas</span>
                
                {idx === 0 && liveMins !== null && (
                  <span className="ml-auto text-xs font-bold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full">
                    viene en {liveMins} min
                  </span>
                )}
              </div>
            </div>
            {/* Si es un trasbordo y no es la ultima pierna */}
            {idx < route.legs.length - 1 && (
               <div className="flex items-center gap-3 relative z-10 my-1 ml-1 bg-slate-50 p-2 rounded-lg border border-slate-100">
                  <GitMerge className="h-4 w-4 text-indigo-500 ml-0.5 shrink-0" />
                  <div className="text-xs text-slate-600 font-medium leading-tight">
                    Bajate en <span className="font-bold text-slate-900">{leg.toStop.name}</span> y tomá el otro bus.
                  </div>
               </div>
            )}
          </div>
        ))}

        {/* Destino final */}
        <div className="flex items-center gap-3 relative z-10">
          <div className="bg-white rounded-full p-[2px]">
            <MapPin className="h-5 w-5 text-rose-500" />
          </div>
          <div className="text-sm text-slate-600 font-medium">
             Llegada a <span className="text-slate-900">{route.legs[route.legs.length - 1].toStop.name}</span>
          </div>
        </div>
      </div>
      
      {isFuzzy && (
        <div className="mt-2 flex gap-1.5 text-[10px] text-amber-700 bg-amber-50 p-1.5 rounded-md border border-amber-100">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          <p>Esta ruta es predictiva; comprueba si la línea va en este sentido antes de subirte.</p>
        </div>
      )}

      <div className="mt-1 text-right">
        <span className="text-[11px] text-slate-400">
          {route.totalWalkMeters}m caminando total
        </span>
      </div>
    </button>
  );
}

export function JourneyResults({ routes, onSelectRoute, loading }: JourneyResultsProps) {
  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center p-4">
        <p className="text-sm font-medium animate-pulse text-slate-500">Calculando mejores rutas...</p>
      </div>
    );
  }

  if (routes.length === 0) {
    return (
      <div className="p-4 text-center rounded-2xl border border-dashed border-slate-300 bg-slate-50">
        <p className="text-sm font-medium text-slate-700">No hay conectividad detectada.</p>
        <p className="text-xs text-slate-500 mt-1">Busca destinos más céntricos o usa la app para pasear a pie.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-3 max-h-[60vh] overflow-y-auto pr-1">
      <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1 ml-1 flex items-center justify-between">
        Rutas Recomendadas ({routes.length})
      </h3>
      {routes.map((route, i) => (
         <RouteCard 
           key={`${route.type}-${route.legs[0].lineId}-${i}`} 
           route={route} 
           onSelect={() => onSelectRoute?.(route)} 
         />
      ))}
    </div>
  );
}
