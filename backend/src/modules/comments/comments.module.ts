import { Module } from '@nestjs/common';
import { HistoryWriter } from '../history/history.writer';
import { AttachmentsModule } from '../attachments/attachments.module';
import { IssuesModule } from '../issues/issues.module';
import { NotificationFanout } from '../notifications/notification.fanout';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

@Module({
  imports: [IssuesModule, AttachmentsModule],
  controllers: [CommentsController],
  providers: [CommentsService, HistoryWriter, NotificationFanout],
  exports: [CommentsService],
})
export class CommentsModule {}
