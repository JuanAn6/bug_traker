import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TPipe } from '../../i18n/i18n.service';
import { Empty } from '../../shared/ui';

@Component({
  selector: 'app-denied',
  imports: [RouterLink, TPipe, Empty],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './denied.html',
  styleUrl: './denied.css',
})
export class Denied {}
