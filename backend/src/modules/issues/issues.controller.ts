import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseBoolPipe, ParseIntPipe, Patch, Post, Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { resolvePaging } from '../../common/pagination/page-query.dto';
import type { AuthUser } from '../auth/auth.types';
import { parseIssueQuery } from './dto/filter-issue.dto';
import { Requires } from '../../common/decorators/requires.decorator';
import {
  BulkAssignDto, BulkDeleteDto, BulkMoveDto, BulkPatchDto, BulkStatusDto, CloneIssueDto,
  MonitorDto, RelationshipDto, TagDto,
} from './dto/bulk.dto';
import { ChangeStatusDto, CreateIssueDto, UpdateIssueDto } from './dto/write-issue.dto';
import { IssueBulkService } from './issue-bulk.service';
import { IssueLinksService } from './issue-links.service';
import { IssueDetailService } from './issue-detail.service';
import { IssuesQueryService } from './issues.query.service';
import { IssuesWriteService } from './issues.write.service';

@Controller('issues')
export class IssuesController {
  constructor(
    private readonly issues: IssuesQueryService,
    private readonly details: IssueDetailService,
    private readonly writes: IssuesWriteService,
    private readonly bulk: IssueBulkService,
    private readonly links: IssueLinksService,
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

  // ─────────────────────────── writes ───────────────────────────

  /**
   * The coarse @Requires gate reads projectId straight off the body; the service re-checks it
   * against the loaded project, because the guard cannot know whether the category's default
   * handler applies or whether the caller is allowed to report on someone else's behalf.
   */
  @Post()
  @Requires('report', { projectFrom: 'body.projectId', resolver: 'project' })
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateIssueDto) {
    return this.writes.create(actor, dto);
  }

  /**
   * A generic patch. Every field maps to the threshold that governs it — `handlerId` needs
   * `assign`, `projectId` needs `move`, `status` needs `changeStatus` and a legal transition —
   * so this cannot be used to sidestep the dedicated endpoints.
   */
  @Patch(':id')
  async update(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateIssueDto,
  ) {
    // Undefined keys are already gone: StripUndefinedPipe runs globally, because leaving them
    // in makes a one-field patch look like a patch of every field on the DTO.
    const { rowVersion, ...patch } = dto;
    return this.writes.update(actor, id, patch as never, rowVersion);
  }

  /** Resolve, close and reopen are all this, plus the workflow's own automations. */
  @Post(':id/status')
  @HttpCode(200)
  changeStatus(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ChangeStatusDto,
  ) {
    return this.writes.changeStatus(actor, id, dto);
  }

  // ─────────────────────────── bulk ───────────────────────────

  /**
   * Every bulk endpoint reports per-id outcomes: `applied` plus `skipped` with a reason each.
   * The frontend drops unauthorized ids silently and calls the whole thing a success; a client
   * should be able to say "12 of 15 updated" instead.
   *
   * Ids are locked in ascending order and processed in chunks, so two overlapping bulk
   * operations wait for each other rather than deadlocking.
   */
  @Post('bulk')
  @HttpCode(200)
  bulkPatch(@CurrentUser() actor: AuthUser, @Body() dto: BulkPatchDto) {
    const { ids, ...patch } = dto;
    return this.bulk.bulkUpdate(actor, ids, patch as never);
  }

  @Post('bulk/status')
  @HttpCode(200)
  bulkStatus(@CurrentUser() actor: AuthUser, @Body() dto: BulkStatusDto) {
    return this.bulk.bulkStatus(actor, dto.ids, dto.status);
  }

  @Post('bulk/assign')
  @HttpCode(200)
  bulkAssign(@CurrentUser() actor: AuthUser, @Body() dto: BulkAssignDto) {
    return this.bulk.bulkAssign(actor, dto.ids, dto.handlerId ?? null);
  }

  @Post('bulk/move')
  @HttpCode(200)
  bulkMove(@CurrentUser() actor: AuthUser, @Body() dto: BulkMoveDto) {
    return this.bulk.bulkMove(actor, dto.ids, dto.projectId);
  }

  /** Soft delete, with an undo token. Nothing is actually removed. */
  @Delete('bulk')
  @HttpCode(200)
  bulkDelete(@CurrentUser() actor: AuthUser, @Body() dto: BulkDeleteDto) {
    return this.bulk.bulkDelete(actor, dto.ids);
  }

  @Delete(':id')
  @HttpCode(200)
  remove(@CurrentUser() actor: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.bulk.bulkDelete(actor, [id]);
  }

  @Post(':id/clone')
  clone(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CloneIssueDto,
  ) {
    return this.bulk.clone(actor, id, dto);
  }

  @Post(':id/sticky')
  @HttpCode(200)
  async sticky(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body('sticky', new ParseBoolPipe()) value: boolean,
  ) {
    return this.writes.update(actor, id, { sticky: value });
  }

  // ─────────────────── relationships, monitors, tags ───────────────────

  /** Creates both directions and needs `manageRelationships`. */
  @Post(':id/relationships')
  @HttpCode(204)
  async addRelationship(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RelationshipDto,
  ) {
    await this.links.addRelationship(actor, id, dto.type, dto.issueId);
  }

  @Delete(':id/relationships/:targetId')
  @HttpCode(204)
  async removeRelationship(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('targetId', ParseIntPipe) targetId: number,
  ) {
    await this.links.removeRelationship(actor, id, targetId);
  }

  /** Monitoring somebody else needs `monitorOthers`, evaluated globally. */
  @Post(':id/monitors')
  @HttpCode(204)
  async setMonitor(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MonitorDto,
  ) {
    await this.links.setMonitor(actor, id, dto.userId ?? actor.id, dto.on);
  }

  @Post(':id/tags')
  @HttpCode(204)
  async addTag(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: TagDto,
  ) {
    await this.links.addTag(actor, id, dto.tag);
  }

  @Delete(':id/tags/:tag')
  @HttpCode(204)
  async removeTag(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('tag') tag: string,
  ) {
    await this.links.removeTag(actor, id, tag);
  }
}