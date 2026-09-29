import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Icon } from '../icon/icon';

@Component({
  selector: 'app-empty',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './empty.html',
  styleUrl: './empty.css',
})
export class Empty {
  readonly icon = input('inbox');
  readonly text = input('');
}
