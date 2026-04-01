import type { BusStop } from "@autobuses/shared";
import { Loader2 } from "lucide-react";

export interface BusStopListItem {
  stop: BusStop;
  sequence?: number;
}

interface BusStopListProps {
  title: string;
  subtitle?: string;
  stops: BusStopListItem[];
  loading?: boolean;
  selectedStopId: string | null;
  onSelectStop: (stop: BusStop) => void;
  emptyMessage: string;
  transitionKey?: string;
}

export function BusStopList({
  title,
  subtitle,
  stops,
  loading = false,
  selectedStopId,
  onSelectStop,
  emptyMessage,
  transitionKey,
}: BusStopListProps) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
            {title}
          </label>
          {subtitle && <p className="mt-1 text-xs text-slate-500">{subtitle}</p>}
        </div>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
      </div>

      <div
        key={transitionKey}
        className="mt-3 max-h-52 overflow-y-auto animate-[fadeIn_200ms_ease-out]"
      >
        {!loading && stops.length === 0 && <p className="text-sm text-slate-500">{emptyMessage}</p>}
        {!loading && stops.length > 0 && (
          <ul className="grid gap-2">
            {stops.map(({ stop, sequence }) => (
              <li key={stop.id}>
                <button
                  type="button"
                  onClick={() => onSelectStop(stop)}
                  className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition ${
                    selectedStopId === stop.id
                      ? "border-[var(--color-brand)] bg-[var(--color-brand-soft)]"
                      : "border-slate-200 hover:bg-slate-50"
                  }`}
                >
                  {sequence !== undefined ? (
                    <span className="inline-flex min-w-7 items-center justify-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                      {sequence + 1}
                    </span>
                  ) : (
                    <span className="font-semibold">{stop.id}</span>
                  )}
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900">{stop.name}</p>
                    <p className="text-xs text-slate-500">ID {stop.id}</p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
