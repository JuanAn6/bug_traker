import { Module } from '@nestjs/common';
import { IssueDetailService } from './issue-detail.service';
import { IssuesController } from './issues.controller';
import { IssuesQueryService } from './issues.query.service';
import { IssuesWriteService } from './issues.write.service';
import { HistoryWriter } from '../history/history.writer';
import { NotificationFanout } from '../notifications/notification.fanout';

@Module({
  controllers: [IssuesController],
  providers: [IssuesQueryService, IssueDetailService, IssuesWriteService, HistoryWriter, NotificationFanout],
  exports: [IssuesQueryService, IssueDetailService, IssuesWriteService],
})
export class IssuesModule {}
