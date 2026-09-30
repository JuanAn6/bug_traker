import { forwardRef, Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { IssueDetailService } from './issue-detail.service';
import { IssuesController } from './issues.controller';
import { IssuesQueryService } from './issues.query.service';
import { IssuesWriteService } from './issues.write.service';
import { IssueBulkService } from './issue-bulk.service';
import { IssueLinksService } from './issue-links.service';
import { HistoryWriter } from '../history/history.writer';
import { NotificationFanout } from '../notifications/notification.fanout';

@Module({
  imports: [forwardRef(() => AttachmentsModule)],
  controllers: [IssuesController],
  providers: [
    IssuesQueryService, IssueDetailService, IssuesWriteService, IssueBulkService,
    IssueLinksService, HistoryWriter, NotificationFanout,
  ],
  exports: [IssuesQueryService, IssueDetailService, IssuesWriteService, IssueBulkService],
})
export class IssuesModule {}
