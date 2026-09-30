import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseBoolPipe, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CommentsService } from './comments.service';
import { CreateNoteDto, UpdateNoteDto } from './dto/comment.dto';

@Controller()
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  /** Private notes are filtered out server-side; the order follows prefs.notesNewestFirst. */
  @Get('issues/:id/notes')
  list(@CurrentUser() actor: AuthUser, @Param('id', ParseIntPipe) issueId: number) {
    return this.comments.list(actor, issueId);
  }

  /** Minutes per author and the total, over the notes this caller can see. */
  @Get('issues/:id/time')
  time(@CurrentUser() actor: AuthUser, @Param('id', ParseIntPipe) issueId: number) {
    return this.comments.timeSummary(actor, issueId);
  }

  @Post('issues/:id/notes')
  create(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) issueId: number,
    @Body() dto: CreateNoteDto,
  ) {
    return this.comments.create(actor, issueId, dto);
  }

  /**
   * Editing somebody else's note needs `editOthersNotes`. The frontend defines that rule and
   * never applies it on the write path — it only hides the buttons — so in the browser any
   * logged-in user can edit another person's note.
   */
  @Patch('notes/:id')
  @HttpCode(204)
  async update(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) noteId: number,
    @Body() dto: UpdateNoteDto,
  ) {
    await this.comments.update(actor, noteId, dto);
  }

  /**
   * `keepFiles=true` detaches the note's attachments so they survive as ticket documents;
   * false deletes them. Defaults to keeping them: losing a file is the harder mistake to undo.
   */
  @Delete('notes/:id')
  @HttpCode(204)
  async remove(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) noteId: number,
    @Query('keepFiles', new ParseBoolPipe({ optional: true })) keepFiles?: boolean,
  ) {
    await this.comments.remove(actor, noteId, keepFiles ?? true);
  }
}
