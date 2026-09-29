import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TPipe } from '../../i18n/i18n.service';
import { Empty } from '../../shared/ui';

@Component({
  selector: 'app-not-found',
  imports: [RouterLink, TPipe, Empty],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './not-found.html',
  styleUrl: './not-found.css',
})
export class NotFound {}
