import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { AggregatesService } from './aggregates.service';
import { SummaryService } from './summary.service';

/**
 * Read-only aggregations, every one scoped to the caller's visible projects.
 *
 * They live together because they share that scoping and because each answers one screen in a
 * single request — the alternative being the nine round trips the home page would otherwise need.
 */
@Controller()
export class SummaryController {
  constructor(
    private readonly summary: SummaryService,
    private readonly aggregates: AggregatesService,
  ) {}

  @Get('summary')
  report(
    @CurrentUser() actor: AuthUser,
    @Query('projectId', new ParseIntPipe({ optional: true })) projectId?: number,
  ) {
    return this.summary.report(actor, projectId);
  }

  @Get('home')
  home(
    @CurrentUser() actor: AuthUser,
    @Query('projectId', new ParseIntPipe({ optional: true })) projectId?: number,
  ) {
    return this.aggregates.home(actor, projectId);
  }

  /** Versions still to ship, by `targetVersion`, plus the sprints in play. */
  @Get('roadmap')
  roadmap(
    @CurrentUser() actor: AuthUser,
    @Query('projectId', new ParseIntPipe({ optional: true })) projectId?: number,
  ) {
    return this.aggregates.roadmap(actor, projectId);
  }

  /** What actually shipped, by `fixedInVersion`, newest release first. */
  @Get('changelog')
  changelog(
    @CurrentUser() actor: AuthUser,
    @Query('projectId', new ParseIntPipe({ optional: true })) projectId?: number,
  ) {
    return this.aggregates.changelog(actor, projectId);
  }

  @Get('board')
  board(
    @CurrentUser() actor: AuthUser,
    @Query('projectId', new ParseIntPipe({ optional: true })) projectId?: number,
    @Query('sprint') sprint?: string,
    @Query('lane') lane?: 'none' | 'handler' | 'priority',
  ) {
    return this.aggregates.board(actor, {
      ...(projectId ? { projectId } : {}),
      ...(sprint !== undefined ? { sprint } : {}),
      ...(lane ? { lane } : {}),
    });
  }

  /** `month=YYYY-MM`. The 42-cell grid is keyed in UTC — see the service for why. */
  @Get('calendar')
  calendar(
    @CurrentUser() actor: AuthUser,
    @Query('month') month?: string,
    @Query('projectId', new ParseIntPipe({ optional: true })) projectId?: number,
  ) {
    return this.aggregates.calendar(
      actor,
      month ?? new Date().toISOString().slice(0, 7),
      projectId,
    );
  }

  @Get('sprints/:id/detail')
  sprintDetail(@CurrentUser() actor: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.aggregates.sprintDetail(actor, id);
  }
}
