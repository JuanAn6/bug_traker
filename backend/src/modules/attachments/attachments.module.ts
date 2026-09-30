import { forwardRef, Module } from '@nestjs/common';
import { HistoryWriter } from '../history/history.writer';
import { IssuesModule } from '../issues/issues.module';
import { NotificationFanout } from '../notifications/notification.fanout';
import { AttachmentPurgeJob } from './attachment-purge.job';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';

@Module({
  // Circular by nature: creating an issue adopts attachments, and an attachment needs the issue
  // visibility check. forwardRef is the sanctioned way to express that in Nest.
  imports: [forwardRef(() => IssuesModule)],
  controllers: [AttachmentsController],
  providers: [AttachmentsService, AttachmentPurgeJob, HistoryWriter, NotificationFanout],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
