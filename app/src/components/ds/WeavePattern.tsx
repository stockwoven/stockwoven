"use client";

import { useEffect, useRef } from "react";

let loader: Promise<NonNullable<Window["Stockwoven"]>> | null = null;
const loadStockwoven = () =>
  (loader ??= import("@/design-system/stockwoven-design-system/js/stockwoven.js").then(() => window.Stockwoven!));

/** The generated weave. Redraws whenever its box changes size. Decorative: hidden from assistive tech. */
export function WeavePattern({
  seed = 3,
  light,
  fade,
  className,
}: {
  seed?: number;
  light?: boolean;
  fade?: number;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let observer: ResizeObserver | undefined;
    let frame = 0;
    let cancelled = false;
    loadStockwoven().then((sw) => {
      const el = canvas.current;
      if (cancelled || !el?.parentElement) return;
      observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => sw.weave(el, { seed, light, fade }));
      });
      observer.observe(el.parentElement);
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [seed, light, fade]);

  return (
    <div className={["sw-weave", className].filter(Boolean).join(" ")} aria-hidden="true">
      <canvas ref={canvas} data-sw-weave="" />
    </div>
  );
}
