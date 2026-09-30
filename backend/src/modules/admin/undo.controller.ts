import { Controller, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { IssueBulkService } from '../issues/issue-bulk.service';

@Controller('undo')
export class UndoController {
  constructor(private readonly bulk: IssueBulkService) {}

  /**
   * Applies the compensating action for a destructive operation.
   *
   * Replaces the frontend's undo, which restores a snapshot of the ENTIRE database — harmless
   * in one browser, catastrophic with several users, since it would silently discard everyone
   * else's work since the snapshot.
   *
   * Single-use, owner-only, and short-lived. It refuses with 409 errors.stale rather than
   * reverting over somebody's later edit.
   */
  @Post(':token')
  @HttpCode(200)
  undo(@CurrentUser() actor: AuthUser, @Param('token') token: string) {
    return this.bulk.undo(actor, token);
  }
}
