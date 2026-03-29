interface LiveBadgeProps {
  minutes: number;
}

export function LiveBadge({ minutes }: LiveBadgeProps) {
  const urgent = minutes < 2;
  return (
    <span
      className={`inline-flex min-w-16 items-center justify-center rounded-full px-2.5 py-1 text-xs font-semibold ${
        urgent
          ? "live-badge-urgent text-white"
          : "bg-emerald-100 text-emerald-700"
      }`}
    >
      {minutes} min
    </span>
  );
}
