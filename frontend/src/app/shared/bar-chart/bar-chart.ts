import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { Bar, niceTicks } from '../charts';

/** Horizontal bar chart: thin bars, rounded data end, direct value labels, native <title> tooltips. */
@Component({
  selector: 'app-bar-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './bar-chart.html',
  styleUrl: './bar-chart.css',
})
export class BarChart {
  readonly data = input.required<Bar[]>();
  readonly label = input('');
  protected readonly W = 480;
  protected readonly ROW = 22;
  protected readonly LABEL_W = 130;
  private readonly BAR_H = 10;
  protected readonly max = computed(() => Math.max(1, ...this.data().map((d) => d.value)));
  protected readonly height = computed(() => this.data().length * this.ROW + 16);
  protected readonly ticks = computed(() => niceTicks(this.max(), 4));

  protected x(v: number) {
    const top = this.ticks().at(-1) ?? this.max();
    return this.LABEL_W + (v / top) * (this.W - this.LABEL_W - 36);
  }

  protected bar(i: number, v: number) {
    const x0 = this.LABEL_W;
    const x1 = Math.max(x0 + 1, this.x(v));
    const y = i * this.ROW + (this.ROW - this.BAR_H) / 2;
    const r = Math.min(4, (x1 - x0) / 2, this.BAR_H / 2);
    // Square at the baseline, rounded at the data end.
    return `M${x0},${y}H${x1 - r}Q${x1},${y} ${x1},${y + r}V${y + this.BAR_H - r}Q${x1},${y + this.BAR_H} ${x1 - r},${y + this.BAR_H}H${x0}Z`;
  }

  protected trim(s: string) {
    return s.length > 20 ? s.slice(0, 19) + '…' : s;
  }
}
