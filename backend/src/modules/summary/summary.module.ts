import { Module } from '@nestjs/common';
import { IssuesModule } from '../issues/issues.module';
import { AggregatesService } from './aggregates.service';
import { SummaryController } from './summary.controller';
import { SummaryService } from './summary.service';

@Module({
  imports: [IssuesModule],
  controllers: [SummaryController],
  providers: [SummaryService, AggregatesService],
  exports: [AggregatesService],
})
export class SummaryModule {}
