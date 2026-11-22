/** Keeps a number inside [min, max]; NaN and infinities become `min`. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Share of `max` reached by `value`, from 0 to 1. A non-positive `max` means no progress to show. */
export function fraction(value: number, max: number): number {
  if (!(max > 0)) return 0;
  return clamp(value / max, 0, 1);
}

export interface RingGeometry {
  readonly radius: number;
  readonly circumference: number;
  /** `stroke-dashoffset` that leaves exactly the filled share of the ring visible. */
  readonly offset: number;
  readonly center: number;
}

export function ringGeometry(size: number, stroke: number, share: number): RingGeometry {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return { radius, circumference, offset: circumference * (1 - share), center: size / 2 };
}

export interface Point {
  readonly date: string;
  readonly value: number;
}

export interface ChartPoint extends Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Places a series in a width x height box with `padding` around it. Points are spread evenly by
 * order (days with no data are not drawn). The vertical scale starts at zero so a small change does
 * not look like a large one.
 */
export function scaleSeries(
  series: readonly Point[],
  width: number,
  height: number,
  padding: number,
): ChartPoint[] {
  const top = Math.max(0, ...series.map((p) => p.value));
  const innerW = width - 2 * padding;
  const innerH = height - 2 * padding;
  return series.map((point, index) => ({
    ...point,
    x: padding + (series.length === 1 ? innerW / 2 : (innerW * index) / (series.length - 1)),
    y: padding + innerH - (top === 0 ? 0 : (innerH * Math.max(0, point.value)) / top),
  }));
}
