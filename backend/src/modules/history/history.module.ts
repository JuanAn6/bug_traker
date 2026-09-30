import { Module } from '@nestjs/common';
import { CommentsModule } from '../comments/comments.module';
import { IssuesModule } from '../issues/issues.module';
import { HistoryController } from './history.controller';
import { HistoryService } from './history.service';

@Module({
  imports: [IssuesModule, CommentsModule],
  controllers: [HistoryController],
  providers: [HistoryService],
})
export class HistoryModule {}
