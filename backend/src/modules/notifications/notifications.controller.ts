import { Body, Controller, Delete, Get, HttpCode, Post, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsInt, IsOptional } from 'class-validator';
import type { NotifyEvent } from '../../shared/models';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { NotificationsService } from './notifications.service';

class MarkReadDto {
  @IsArray() @IsInt({ each: true })
  ids!: number[];

  @IsOptional() @IsBoolean()
  read?: boolean;
}

class RemoveDto {
  @IsArray() @IsInt({ each: true })
  ids!: number[];
}

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('type') type?: NotifyEvent,
  ) {
    return this.notifications.list(user, {
      unreadOnly: unreadOnly === 'true',
      ...(type ? { type } : {}),
    });
  }

  /** What the toolbar bell polls. */
  @Get('unread-count')
  async unreadCount(@CurrentUser() user: AuthUser) {
    return { unread: await this.notifications.unreadCount(user) };
  }

  /** Always scoped to the caller's own rows — ids alone are not authorization. */
  @Post('read')
  @HttpCode(200)
  markRead(@CurrentUser() user: AuthUser, @Body() dto: MarkReadDto) {
    return this.notifications.markRead(user, dto.ids, dto.read ?? true);
  }

  @Post('read-all')
  @HttpCode(200)
  markAllRead(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user);
  }

  @Delete()
  @HttpCode(200)
  remove(@CurrentUser() user: AuthUser, @Body() dto: RemoveDto) {
    return this.notifications.remove(user, dto.ids);
  }

  @Delete('read')
  @HttpCode(200)
  removeRead(@CurrentUser() user: AuthUser) {
    return this.notifications.removeRead(user);
  }
}
