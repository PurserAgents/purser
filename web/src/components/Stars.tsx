/** A rating from paid jobs as five drawn stars (no star characters: they turn into emoji on some phones). */
export function Stars({ value, size = 14 }: { value: number | null; size?: number }) {
  const v = value ?? 0;
  return (
    <span className="stars" role="img" aria-label={value === null ? "Not rated yet" : `${value.toFixed(1)} of 5`}>
      {[0, 1, 2, 3, 4].map((i) => {
        const fill = Math.max(0, Math.min(1, v - i));
        const id = `st-${i}-${Math.round(v * 100)}`;
        return (
          <svg key={i} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
            <defs>
              <linearGradient id={id}>
                <stop offset={`${fill * 100}%`} stopColor="currentColor" />
                <stop offset={`${fill * 100}%`} stopColor="currentColor" stopOpacity="0.16" />
              </linearGradient>
            </defs>
            <path fill={`url(#${id})`} d="M12 2.6l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.4l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z" />
          </svg>
        );
      })}
    </span>
  );
}

/** "4.8 of 5 from 12 paid jobs", or the plain fact that nobody rated yet. */
export function ratingText(rating: number | null, ratings: number): string {
  if (rating === null || ratings === 0) return "No ratings yet";
  return `${rating.toFixed(1)} of 5 from ${ratings} paid job${ratings === 1 ? "" : "s"}`;
}
