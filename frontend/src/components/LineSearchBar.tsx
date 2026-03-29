import type { LineSummary } from "@autobuses/shared";
import { useMemo, useState } from "react";
import { useDebouncedValue } from "../hooks/useDebouncedValue";

interface LineSearchBarProps {
  lines: LineSummary[];
  loading: boolean;
  selectedLineId: string | null;
  onSelectLine: (line: LineSummary) => void;
}

const MAX_VISIBLE = 12;

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-ES")
    .trim();
}

export function LineSearchBar({
  lines,
  loading,
  selectedLineId,
  onSelectLine,
}: LineSearchBarProps) {
  console.log("Lineas cargadas:", lines);
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, 220);

  const filtered = useMemo(() => {
    const q = normalizeText(debounced);
    if (!q) return lines.slice(0, MAX_VISIBLE);
    return lines
      .filter((line) => {
        const id = normalizeText(line.id);
        const destination = normalizeText(line.destination ?? "");
        const name = normalizeText(line.name);
        const friendly = normalizeText(line.friendlyName);
        return (
          id.includes(q) ||
          destination.includes(q) ||
          name.includes(q) ||
          friendly.includes(q)
        );
      })
      .slice(0, MAX_VISIBLE);
  }, [debounced, lines]);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
        Buscar linea
      </label>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Ej: C3 o destino"
        className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none ring-[var(--color-brand)] focus:ring-2"
      />

      <div className="mt-3 max-h-52 overflow-y-auto">
        {loading && <p className="text-sm text-slate-500">Cargando lineas...</p>}
        {!loading && filtered.length === 0 && (
          <p className="text-sm text-slate-500">No hay lineas para ese filtro.</p>
        )}
        {!loading && filtered.length > 0 && (
          <ul className="grid gap-2">
            {filtered.map((line) => (
              <li key={line.id}>
                <button
                  type="button"
                  onClick={() => onSelectLine(line)}
                  className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition ${
                    selectedLineId === line.id
                      ? "border-[var(--color-brand)] bg-[var(--color-brand-soft)]"
                      : "border-slate-200 hover:bg-slate-50"
                  }`}
                >
                  <span className="inline-flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: line.color }}
                    />
                    <span className="font-semibold">{line.id}</span>
                  </span>
                  <span className="ml-2 text-slate-600">
                    {line.destination ?? line.friendlyName ?? line.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
