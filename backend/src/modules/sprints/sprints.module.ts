import { Module } from '@nestjs/common';
import { IssuesModule } from '../issues/issues.module';
import { SprintsController } from './sprints.controller';
import { SprintsService } from './sprints.service';

@Module({
  imports: [IssuesModule],
  controllers: [SprintsController],
  providers: [SprintsService],
})
export class SprintsModule {}
