// Shared animation helpers — the app's signature ease is a bouncy spring.
//
// Applied to discrete UI events only (modal pop-ins, report cards arriving,
// tab switches).  Continuously-updating surfaces (the eval bar, progress
// bars) keep their plain CSS transitions — a spring would oscillate
// constantly there.
import { useLayoutEffect, useRef, type CSSProperties, type MouseEventHandler, type ReactNode } from "react";
import { animate, spring } from "animejs";

/** The app's signature ease.  bounce: 0.4 / duration: 500, per the
 *  anime.js easing-editor "bouncy" preset. */
export const bouncy = (bounce = 0.4, duration = 500) =>
  spring({ bounce, duration });

const reducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Pop-in: fade + rise + scale with a springy overshoot. */
export function popIn(el: HTMLElement | null, delay = 0) {
  if (!el || reducedMotion()) return;
  animate(el, {
    opacity: [0, 1],
    scale: [0.9, 1],
    y: [12, 0],
    ease: bouncy(),
    delay,
  });
}

/** Mount-and-pop wrapper for modal cards, panes, and inline panels.
 *  (useLayoutEffect so the "from" state applies before first paint —
 *  no flash of the final frame.) */
export function PopIn({
  className,
  style,
  delay = 0,
  onClick,
  children,
}: {
  className?: string;
  style?: CSSProperties;
  delay?: number;
  onClick?: MouseEventHandler<HTMLDivElement>;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    popIn(ref.current, delay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={ref} className={className} style={style} onClick={onClick}>
      {children}
    </div>
  );
}
