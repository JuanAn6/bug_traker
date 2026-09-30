import { Controller, Get, Param, ParseIntPipe, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { resolvePaging } from '../../common/pagination/page-query.dto';
import type { AuthUser } from '../auth/auth.types';
import { parseIssueQuery } from './dto/filter-issue.dto';
import { IssueDetailService } from './issue-detail.service';
import { IssuesQueryService } from './issues.query.service';

@Controller('issues')
export class IssuesController {
  constructor(
    private readonly issues: IssuesQueryService,
    private readonly details: IssueDetailService,
  ) {}

  /**
   * The issue list, taking the full FilterCriteria as query parameters in exactly the shape
   * criteriaToParams() produces — so a filter URL copied out of the UI works here verbatim.
   *
   * With no parameters it behaves like the UI's default view: closed issues hidden
   * (hideStatus defaults to 'closed') and subprojects included. That is emptyCriteria()'s
   * doing, applied inside the query builder rather than here.
   *
   * The raw query is read off the request instead of through a DTO class: the criteria have
   * 36 fields with three sentinel conventions, and decoding them with the frontend's own
   * paramsToCriteria() is the only way to guarantee the two agree.
   */
  @Get()
  async list(@CurrentUser() actor: AuthUser, @Req() request: FastifyRequest) {
    const parsed = parseIssueQuery((request.query ?? {}) as Record<string, unknown>);
    const paging = resolvePaging(
      { page: parsed.page, ...(parsed.pageSize === undefined ? {} : { pageSize: parsed.pageSize }) },
      // Falls back to the caller's own preference, not a server-wide constant.
      actor.prefs.pageSize,
    );
    return this.issues.list(actor, parsed.criteria, parsed.sort, {
      page: paging.page,
      pageSize: paging.pageSize,
      withIds: parsed.withIds,
    });
  }

  /** Count only — what the navigator's per-node badges need. */
  @Get('count')
  async count(@CurrentUser() actor: AuthUser, @Req() request: FastifyRequest) {
    const parsed = parseIssueQuery((request.query ?? {}) as Record<string, unknown>);
    return { total: await this.issues.count(actor, parsed.criteria) };
  }

  /**
   * The whole issue view in one request: the issue, its project's categories and versions, the
   * sprint, tags, monitors, resolved relationships, custom fields with values, the transitions
   * this actor may actually perform, the permission flags the UI renders from, and the
   * assignable users.
   *
   * 404 — not 403 — for an issue the caller cannot see: answering "forbidden" would confirm it
   * exists, which is the leak a private issue is meant to prevent.
   */
  @Get(':id')
  async findOne(@CurrentUser() actor: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.details.detail(actor, id);
  }
}
