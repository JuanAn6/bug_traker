import { Controller, Get, ParseIntPipe, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CatalogService } from './catalog.service';

/**
 * Reference data, all of it scoped to what the caller can see.
 *
 * These are separate endpoints rather than one bundle because the shell caches them
 * independently: the project list changes rarely, tags change on every tag edit.
 */
@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('projects')
  projects(@CurrentUser() actor: AuthUser) {
    return this.catalog.projects(actor);
  }

  @Get('users')
  users() {
    return this.catalog.users();
  }

  @Get('sprints')
  sprints(
    @CurrentUser() actor: AuthUser,
    @Query('projectId', new ParseIntPipe({ optional: true })) projectId?: number,
  ) {
    return this.catalog.sprints(actor, projectId);
  }

  @Get('tags')
  tags(@CurrentUser() actor: AuthUser, @Query('query') query?: string) {
    return this.catalog.tags(actor, query);
  }

  @Get('custom-fields')
  customFields() {
    return this.catalog.customFields();
  }

  @Get('saved-filters')
  savedFilters(@CurrentUser() actor: AuthUser) {
    return this.catalog.savedFilters(actor);
  }
}
