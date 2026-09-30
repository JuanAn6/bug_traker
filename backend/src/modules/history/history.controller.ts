import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { HistoryService } from './history.service';

@Controller()
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get('issues/:id/history')
  forIssue(@CurrentUser() actor: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.history.forIssue(actor, id);
  }

  /** History and notes interleaved, with `note_added` dropped so comments appear once. */
  @Get('issues/:id/timeline')
  timeline(@CurrentUser() actor: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.history.timeline(actor, id);
  }

  @Get('activity')
  activity(
    @CurrentUser() actor: AuthUser,
    @Query('projectId', new ParseIntPipe({ optional: true })) projectId?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.history.activity(actor, {
      ...(projectId ? { projectId } : {}),
      ...(limit ? { limit } : {}),
    });
  }
}
