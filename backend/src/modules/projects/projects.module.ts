import { Module } from '@nestjs/common';
import { HistoryWriter } from '../history/history.writer';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService, HistoryWriter],
})
export class ProjectsModule {}
