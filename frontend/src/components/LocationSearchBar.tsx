import { useState, useEffect } from "react";
import { Loader2, MapPin, Search } from "lucide-react";
import { geocodeVigo, type GeocoderResult } from "../api/geocoder";
import { useDebouncedValue } from "../hooks/useDebouncedValue";

interface LocationSearchBarProps {
  onLocationSelect: (lat: number, lon: number, name: string) => void;
  loadingLocation?: boolean; // Por si el layour indica que estamos calculando
}

export function LocationSearchBar({
  onLocationSelect,
  loadingLocation = false,
}: LocationSearchBarProps) {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 600); // 600ms para evitar spam a Nominatim
  const [results, setResults] = useState<GeocoderResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  useEffect(() => {
    if (!debouncedQuery || debouncedQuery.length < 3) {
      setResults([]);
      setHasSearched(false);
      return;
    }

    let active = true;
    setIsSearching(true);
    setHasSearched(true);
    
    geocodeVigo(debouncedQuery)
      .then((data) => {
        if (!active) return;
        setResults(data);
      })
      .catch((err) => {
        console.error("Error geocoding:", err);
        if (active) setResults([]);
      })
      .finally(() => {
        if (active) setIsSearching(false);
      });

    return () => {
      active = false;
    };
  }, [debouncedQuery]);

  const handleSelect = (result: GeocoderResult) => {
    const lat = parseFloat(result.lat);
    const lon = parseFloat(result.lon);
    
    // Mostramos el nombre principal (antes de la primera coma) para no ensuciar la UI
    const friendlyName = result.display_name.split(",")[0];
    
    setQuery(friendlyName);
    setResults([]); // Limpiar popover al seleccionar
    
    onLocationSelect(lat, lon, friendlyName);
  };

  return (
    <section className="relative rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
        ¿A dónde vamos?
      </label>
      
      <div className="relative mt-2">
        <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
          {(isSearching || loadingLocation) ? (
            <Loader2 className="h-4 w-4 animate-spin text-[var(--color-brand)]" />
          ) : (
            <Search className="h-4 w-4 text-slate-400" />
          )}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ej: Plaza de América, Samil..."
          className="w-full rounded-lg border border-slate-200 py-2 pl-9 pr-3 text-sm outline-none ring-[var(--color-brand)] focus:border-transparent focus:ring-2 transition-all"
        />
      </div>

      {hasSearched && debouncedQuery.length >= 3 && results.length === 0 && !isSearching && (
        <p className="mt-3 text-sm text-slate-500">No encontramos resultados precisos en Vigo.</p>
      )}

      {results.length > 0 && (
        <ul className="mt-3 max-h-[40vh] overflow-y-auto rounded-lg border border-slate-100 bg-white shadow-sm ring-1 ring-slate-200">
          {results.map((result) => {
            const parts = result.display_name.split(", ");
            const mainText = parts[0];
            const secondaryText = parts.slice(1, 3).join(", "); // Contexto corto
            
            return (
              <li key={result.place_id}>
                <button
                  type="button"
                  onClick={() => handleSelect(result)}
                  className="flex w-full items-start gap-3 border-b border-slate-100 px-3 py-3 text-left transition hover:bg-slate-50 last:border-0"
                >
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                  <div className="flex flex-col">
                    <span className="text-sm font-semibold text-slate-700">{mainText}</span>
                    <span className="text-xs text-slate-500">{secondaryText}</span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
