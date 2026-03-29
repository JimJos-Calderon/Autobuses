import type { LiveArrival } from "@autobuses/shared";
import { Clock3 } from "lucide-react";
import type { CSSProperties } from "react";
import { LiveBadge } from "./LiveBadge";

interface BusListProps {
  arrivals: LiveArrival[];
  colorByLine?: Record<string, string>;
}

function colorForLine(linea: string): string {
  const clean = linea.toUpperCase().trim();
  if (clean.startsWith("C1")) return "oklch(0.62 0.23 25)";
  if (clean.startsWith("L5")) return "oklch(0.56 0.15 250)";
  if (clean.startsWith("C")) return "oklch(0.64 0.18 10)";
  if (clean.startsWith("L")) return "oklch(0.55 0.16 240)";
  if (clean.startsWith("A")) return "oklch(0.65 0.14 150)";
  return "oklch(0.6 0.05 250)";
}

function resolveLineColor(linea: string, colorByLine?: Record<string, string>): string {
  const key = linea.trim().toUpperCase();
  if (!colorByLine) return colorForLine(linea);
  return (
    colorByLine[key] ??
    colorByLine[key.replace(/[A-Z]$/, "")] ??
    colorForLine(linea)
  );
}

export function BusList({ arrivals, colorByLine }: BusListProps) {
  if (arrivals.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
        Sin informacion de tiempo real en este momento (Servidor Vitrasa no disponible).
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {arrivals.map((arrival) => {
        const style = {
          "--line-color": resolveLineColor(arrival.linea, colorByLine),
        } as CSSProperties;
        const isTheoretical = arrival.isTheoretical === true;
        return (
          <article
            key={`${arrival.linea}-${arrival.destino}-${arrival.tiempo_minutos}`}
            style={style}
            className={`rounded-xl border p-3 shadow-sm ${
              isTheoretical
                ? "border-slate-200 bg-slate-50"
                : "border-slate-200 bg-white"
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-2 rounded-lg bg-slate-100 px-2 py-1 text-sm font-bold text-slate-700">
                <span className="h-2.5 w-2.5 rounded-full bg-[var(--line-color)]" />
                {arrival.linea}
              </span>
              <LiveBadge minutes={arrival.tiempo_minutos} />
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <p className="text-sm text-slate-700">{arrival.destino}</p>
              {isTheoretical && (
                <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                  <Clock3 className="h-3.5 w-3.5" />
                  Teorico
                </span>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
