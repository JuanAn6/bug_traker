import { Module } from '@nestjs/common';
import { IssueDetailService } from './issue-detail.service';
import { IssuesController } from './issues.controller';
import { IssuesQueryService } from './issues.query.service';

@Module({
  controllers: [IssuesController],
  providers: [IssuesQueryService, IssueDetailService],
  exports: [IssuesQueryService, IssueDetailService],
})
export class IssuesModule {}
