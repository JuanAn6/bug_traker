import { Module } from '@nestjs/common';
import { WorkflowController } from './workflow.controller';
import { WorkflowWriteService } from './workflow.write.service';

/** WorkflowService itself lives in CoreModule (global) — everything depends on it. */
@Module({
  controllers: [WorkflowController],
  providers: [WorkflowWriteService],
})
export class WorkflowModule {}
