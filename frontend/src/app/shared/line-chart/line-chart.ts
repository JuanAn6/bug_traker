import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { Series, niceTicks } from '../charts';

/** Line chart with recessive grid, legend and a hover crosshair tooltip. */
@Component({
  selector: 'app-line-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './line-chart.html',
  styleUrl: './line-chart.css',
})
export class LineChart {
  readonly series = input.required<Series[]>();
  readonly labels = input.required<string[]>();
  readonly label = input('');
  protected readonly W = 600;
  protected readonly H = 220;
  protected readonly L = 32;
  protected readonly R = 12;
  protected readonly T = 10;
  protected readonly B = 22;
  protected readonly idx = signal(-1);
  protected readonly max = computed(() => Math.max(1, ...this.series().flatMap((s) => s.values.map((v) => v ?? 0))));
  protected readonly ticks = computed(() => niceTicks(this.max(), 4));
  protected readonly xLabels = computed(() => {
    const n = this.labels().length;
    const step = Math.max(1, Math.ceil(n / 7));
    return this.labels().map((text, i) => ({ text, i })).filter((l) => l.i % step === 0 || l.i === n - 1);
  });

  protected x(i: number) {
    const n = Math.max(1, this.labels().length - 1);
    return this.L + (i / n) * (this.W - this.L - this.R);
  }

  protected y(v: number) {
    const top = this.ticks().at(-1) ?? this.max();
    return this.H - this.B - (v / top) * (this.H - this.B - this.T);
  }

  protected path(s: Series) {
    let d = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${this.x(i).toFixed(1)},${this.y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  }

  protected hover(e: PointerEvent) {
    const svg = e.currentTarget as SVGSVGElement;
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * this.W;
    const n = this.labels().length - 1;
    const i = Math.round(((px - this.L) / (this.W - this.L - this.R)) * n);
    this.idx.set(Math.max(0, Math.min(n, i)));
  }
}
