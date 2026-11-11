"use client";

import { useEffect, useRef } from "react";

function render(value: number, decimals: number, prefix: string, suffix: string): string {
  const fixed = value.toFixed(decimals);
  const [whole, frac] = fixed.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return prefix + grouped + (frac ? "." + frac : "") + suffix;
}

/**
 * A number that counts up when it scrolls into view.
 * The server renders the final value, so it reads correctly with no JavaScript,
 * for screen readers (aria-label) and with reduced motion.
 * `value` is a display number only: money arithmetic stays in base units.
 */
export function CountUp({
  value,
  decimals = 0,
  prefix = "",
  suffix = "",
  duration = 1600,
}: {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const final = render(value, decimals, prefix, suffix);

  useEffect(() => {
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window)) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rect = el.getBoundingClientRect();
    // Already on screen at load: leave the final value, no flash to zero.
    if (rect.top < window.innerHeight && rect.bottom > 0) return;

    let frame = 0;
    el.textContent = render(0, decimals, prefix, suffix);
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        const start = performance.now();
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / duration);
          const eased = 1 - Math.pow(1 - t, 4);
          el.textContent = render(value * eased, decimals, prefix, suffix);
          if (t < 1) frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      el.textContent = render(value, decimals, prefix, suffix);
    };
  }, [value, decimals, prefix, suffix, duration]);

  return (
    <span className="num" aria-label={final}>
      <span ref={ref} aria-hidden="true">
        {final}
      </span>
    </span>
  );
}
