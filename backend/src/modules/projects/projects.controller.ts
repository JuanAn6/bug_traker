import {
  Body, Controller, Delete, HttpCode, Param, ParseIntPipe, Post, Put, Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Requires } from '../../common/decorators/requires.decorator';
import type { AuthUser } from '../auth/auth.types';
import {
  CreateProjectDto, ReorderVersionsDto, UpdateProjectDto,
} from './dto/project.dto';
import { ProjectsService } from './projects.service';

/** Reads live in the catalog module; this is writes only, all behind `manageProject`. */
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  @Requires('manageProject')
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateProjectDto) {
    return this.projects.create(actor, dto);
  }

  /**
   * Whole-project save. Categories and versions are complete lists — what is absent is deleted —
   * and each entry may carry `previousName` so a rename rewrites the issues that reference it
   * instead of orphaning them.
   */
  @Put(':id')
  @HttpCode(204)
  @Requires('manageProject', { projectFrom: 'param.id', resolver: 'project' })
  async update(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProjectDto,
  ) {
    await this.projects.update(actor, id, dto);
  }

  @Put(':id/versions/order')
  @HttpCode(204)
  @Requires('manageProject', { projectFrom: 'param.id', resolver: 'project' })
  async reorderVersions(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReorderVersionsDto,
  ) {
    await this.projects.reorderVersions(id, dto.names);
  }

  @Delete(':id')
  @HttpCode(204)
  @Requires('manageProject', { projectFrom: 'param.id', resolver: 'project' })
  async remove(@CurrentUser() actor: AuthUser, @Param('id', ParseIntPipe) id: number) {
    await this.projects.remove(actor, id);
  }

  @Post('key-available')
  @HttpCode(200)
  async keyAvailable(
    @Body('key') key: string,
    @Query('exceptId', new ParseIntPipe({ optional: true })) exceptId?: number,
  ) {
    return { available: await this.projects.keyAvailable(key, exceptId) };
  }
}
