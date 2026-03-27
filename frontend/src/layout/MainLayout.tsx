import type { BusStop } from "@autobuses/shared";
import { Bus, Loader2, Map as MapIcon, MapPin } from "lucide-react";
import { useCallback, useState } from "react";
import { fetchStopById, formatStopError } from "../api/stops";

/** IDs de ejemplo para probar cuando conozcas códigos reales del JSON municipal. */
const SAMPLE_STOP_IDS = ["1", "2", "3"];

export function MainLayout() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BusStop | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStop = useCallback(async (id: string) => {
    setSelectedId(id);
    setLoading(true);
    setError(null);
    setDetail(null);
    try {
      const stop = await fetchStopById(id);
      setDetail(stop);
    } catch (e) {
      setError(formatStopError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div className="flex min-h-full flex-col bg-[var(--color-bus-surface)] text-slate-900">
      <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-3 shadow-sm">
        <Bus className="h-7 w-7 text-[var(--color-bus-primary)]" aria-hidden />
        <div>
          <h1 className="text-lg font-semibold tracking-tight">BusVigo</h1>
          <p className="text-xs text-[var(--color-bus-muted)]">
            Transporte urbano — Vigo
          </p>
        </div>
      </header>

      <main className="grid flex-1 grid-cols-1 gap-0 md:grid-cols-3">
        <section
          className="relative flex min-h-[40vh] flex-col border-b border-slate-200 bg-slate-100 md:col-span-2 md:min-h-0 md:border-b-0 md:border-r"
          aria-label="Mapa"
        >
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="flex max-w-md flex-col items-center gap-3 text-center text-slate-600">
              <MapIcon className="h-16 w-16 opacity-40" strokeWidth={1.25} aria-hidden />
              <p className="text-sm">
                Aquí integrarás el mapa (p. ej. Leaflet o MapLibre) con las paradas.
              </p>
            </div>
          </div>
        </section>

        <aside
          className="flex min-h-[35vh] flex-col bg-white md:min-h-0"
          aria-label="Lista de paradas"
        >
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-800">Paradas</h2>
            <p className="text-xs text-slate-500">
              Pulsa un id de prueba o usa el buscador (BFF{' '}
              <code className="rounded bg-slate-100 px-1 text-[11px]">/api/v1/stops/:id</code>
              ).
            </p>
          </div>

          <div className="flex flex-wrap gap-2 border-b border-slate-100 px-4 py-2">
            {SAMPLE_STOP_IDS.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => void loadStop(id)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  selectedId === id
                    ? "border-[var(--color-bus-primary)] bg-blue-50 text-[var(--color-bus-primary)]"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                Id {id}
              </button>
            ))}
          </div>

          <StopSearchForm onSearch={(id) => void loadStop(id)} />

          <div className="flex-1 overflow-y-auto px-4 py-3">
            {loading && (
              <div className="flex items-center gap-2 text-sm text-slate-600">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Cargando…
              </div>
            )}
            {error && (
              <p className="text-sm text-red-600" role="alert">
                {error}
              </p>
            )}
            {detail && !loading && (
              <article className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                <div className="flex items-start gap-2">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-bus-primary)]" />
                  <div>
                    <p className="font-medium text-slate-900">{detail.name}</p>
                    <p className="text-xs text-slate-500">id: {detail.id}</p>
                    {(detail.lat !== undefined && detail.lon !== undefined) && (
                      <p className="mt-1 text-xs text-slate-600">
                        {detail.lat.toFixed(5)}, {detail.lon.toFixed(5)}
                      </p>
                    )}
                  </div>
                </div>
              </article>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}

function StopSearchForm({ onSearch }: { onSearch: (id: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="flex gap-2 border-b border-slate-100 px-4 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        const id = value.trim();
        if (id) onSearch(id);
      }}
    >
      <input
        className="min-w-0 flex-1 rounded-md border border-slate-200 px-2 py-1.5 text-sm outline-none ring-[var(--color-bus-primary)] focus:ring-2"
        placeholder="Código de parada"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label="Código de parada"
      />
      <button
        type="submit"
        className="shrink-0 rounded-md bg-[var(--color-bus-primary)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
      >
        Buscar
      </button>
    </form>
  );
}
