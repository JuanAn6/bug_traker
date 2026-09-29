// Types and helpers shared by the SVG chart components (bar-chart, line-chart).

export interface Bar { label: string; value: number; color?: string; hint?: string; }

export interface Series { name: string; color: string; values: (number | null)[]; dashed?: boolean; }

/** Round axis ticks (1/2/5 × 10^n) from 0 up to at least `max`. */
export function niceTicks(max: number, count: number): number[] {
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}
