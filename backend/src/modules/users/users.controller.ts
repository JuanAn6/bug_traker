import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsBoolean, IsEmail, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min,
  MinLength, ValidateNested,
} from 'class-validator';
import { ACCESS_LEVELS, HOME_WIDGETS, LANGUAGES } from '../../shared/config';
import type { AccessLevel, UserPrefs } from '../../shared/models';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Requires } from '../../common/decorators/requires.decorator';
import type { AuthUser } from '../auth/auth.types';
import { UsersService } from './users.service';

class CreateUserDto {
  @IsString() @MinLength(1) @MaxLength(64) username!: string;
  @IsString() @MinLength(1) @MaxLength(128) realName!: string;
  @IsEmail() @MaxLength(190) email!: string;
  @IsIn(ACCESS_LEVELS) accessLevel!: AccessLevel;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(16) avatarColor?: string;
  @IsOptional() @IsString() @MinLength(8) @MaxLength(256) password?: string;
}

class UpdateUserDto {
  @IsOptional() @IsString() @MaxLength(64) username?: string;
  @IsOptional() @IsString() @MaxLength(128) realName?: string;
  @IsOptional() @IsEmail() @MaxLength(190) email?: string;
  @IsOptional() @IsIn(ACCESS_LEVELS) accessLevel?: AccessLevel;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(16) avatarColor?: string;
  @IsOptional() @IsString() @MinLength(8) @MaxLength(256) password?: string;
}

/** Profile fields a user may change about themselves. Note: not accessLevel. */
class UpdateMeDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) realName?: string;
  @IsOptional() @IsEmail() @MaxLength(190) email?: string;
  @IsOptional() @IsString() @MaxLength(16) avatarColor?: string;
}

class NotifyPrefsDto {
  @IsBoolean() assigned!: boolean;
  @IsBoolean() mentioned!: boolean;
  @IsBoolean() status!: boolean;
  @IsBoolean() note!: boolean;
  @IsBoolean() attachment!: boolean;
}

/**
 * Preferences, validated explicitly.
 *
 * A bare `Partial<UserPrefs>` parameter looks convenient but disables validation entirely:
 * ValidationPipe needs a DTO class to have anything to check, so an interface type means
 * `whitelist` and `forbidNonWhitelisted` never run and any shape gets through to the update.
 */
class UpdatePrefsDto {
  @IsOptional() @IsIn(LANGUAGES.map((l) => l.code)) language?: string;
  @IsOptional() @IsIn(['light', 'dark', 'system']) theme?: 'light' | 'dark' | 'system';
  @IsOptional() @IsIn(['compact', 'comfortable']) density?: 'compact' | 'comfortable';
  @IsOptional() @IsInt() defaultProjectId?: number | null;
  /** 0 means "all" in the page-size selector; the list endpoint caps it. */
  @IsOptional() @IsInt() @Min(0) @Max(200) pageSize?: number;
  @IsOptional() @IsBoolean() notesNewestFirst?: boolean;
  @IsOptional() @IsIn(HOME_WIDGETS, { each: true }) homeWidgets?: string[];
  /** Replaced whole, not merged: the client always sends every flag. */
  @IsOptional() @IsObject() @ValidateNested() @Type(() => NotifyPrefsDto) notify?: NotifyPrefsDto;
}

@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** The full record with the email. The unprivileged list lives at GET /users in the catalog. */
  @Get('users/:id')
  @Requires('manageUsers')
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.users.detail(id);
  }

  @Get('users/username-available')
  @Requires('manageUsers')
  async usernameAvailable(
    @Query('username') username: string,
    @Query('exceptId', new ParseIntPipe({ optional: true })) exceptId?: number,
  ) {
    return { available: await this.users.usernameAvailable(username, exceptId) };
  }

  @Post('users')
  @Requires('manageUsers')
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Patch('users/:id')
  @HttpCode(204)
  @Requires('manageUsers')
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateUserDto) {
    await this.users.update(id, dto);
  }

  /**
   * Soft delete: the row stays so "reported by" keeps resolving. `reassignTo` takes over their
   * assigned issues; omit it to leave them unassigned.
   */
  @Delete('users/:id')
  @HttpCode(204)
  @Requires('manageUsers')
  async remove(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Query('reassignTo', new ParseIntPipe({ optional: true })) reassignTo?: number,
  ) {
    await this.users.remove(actor, id, reassignTo ?? null);
  }

  /** Own profile. Access level is deliberately not settable here. */
  @Patch('me')
  @HttpCode(204)
  async updateMe(@CurrentUser() actor: AuthUser, @Body() dto: UpdateMeDto) {
    await this.users.update(actor.id, dto);
  }

  @Patch('me/prefs')
  @HttpCode(204)
  async updatePrefs(@CurrentUser() actor: AuthUser, @Body() dto: UpdatePrefsDto) {
    await this.users.updatePrefs(actor.id, dto as Partial<UserPrefs>);
  }
}
