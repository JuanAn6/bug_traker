import {
  Body, Controller, Delete, HttpCode, Param, ParseIntPipe, Patch, Post,
} from '@nestjs/common';
import { IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Requires } from '../../common/decorators/requires.decorator';
import type { AuthUser } from '../auth/auth.types';
import { SprintsService } from './sprints.service';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

class CreateSprintDto {
  @IsInt() @Min(1) projectId!: number;
  @IsString() @MaxLength(128) name!: string;
  @IsOptional() @IsString() @MaxLength(512) goal?: string;
  @Matches(DATE) start!: string;
  @Matches(DATE) end!: string;
  @IsOptional() @IsInt() @Min(0) capacity?: number;
}

class UpdateSprintDto {
  @IsOptional() @IsString() @MaxLength(128) name?: string;
  @IsOptional() @IsString() @MaxLength(512) goal?: string;
  @IsOptional() @Matches(DATE) start?: string;
  @IsOptional() @Matches(DATE) end?: string;
  @IsOptional() @IsInt() @Min(0) capacity?: number;
}

class CompleteSprintDto {
  /** null sends the unfinished work back to the backlog. */
  @IsOptional() @IsInt()
  moveTo?: number | null;
}

@Controller('sprints')
export class SprintsController {
  constructor(private readonly sprints: SprintsService) {}

  @Post()
  @Requires('manageSprints', { projectFrom: 'body.projectId', resolver: 'project' })
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateSprintDto) {
    return this.sprints.create(actor, dto);
  }

  @Patch(':id')
  @HttpCode(204)
  @Requires('manageSprints', { projectFrom: 'param.id', resolver: 'sprint' })
  async update(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSprintDto,
  ) {
    await this.sprints.update(actor, id, dto);
  }

  /** A future start date is clamped to today — a running sprint cannot begin tomorrow. */
  @Post(':id/start')
  @HttpCode(204)
  @Requires('manageSprints', { projectFrom: 'param.id', resolver: 'sprint' })
  async start(@Param('id', ParseIntPipe) id: number) {
    await this.sprints.start(id);
  }

  /**
   * Closes the sprint and moves whatever is unfinished, each move recorded as a real field
   * change rather than a silent UPDATE.
   */
  @Post(':id/complete')
  @HttpCode(200)
  @Requires('manageSprints', { projectFrom: 'param.id', resolver: 'sprint' })
  complete(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CompleteSprintDto,
  ) {
    return this.sprints.complete(actor, id, dto.moveTo ?? null);
  }

  @Delete(':id')
  @HttpCode(204)
  @Requires('manageSprints', { projectFrom: 'param.id', resolver: 'sprint' })
  async remove(@CurrentUser() actor: AuthUser, @Param('id', ParseIntPipe) id: number) {
    await this.sprints.remove(actor, id);
  }
}
