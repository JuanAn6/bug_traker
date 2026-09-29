import { Body, Controller, Get, Post, Put, UsePipes } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Requires } from '../../common/decorators/requires.decorator';
import { ZodBodyPipe } from '../../common/pipes/zod-body.pipe';
import { WorkflowService } from '../../core/workflow/workflow.service';
import { workflowUpdateSchema, type WorkflowUpdate } from './workflow.schema';
import { WorkflowWriteService } from './workflow.write.service';

@Controller('workflow')
export class WorkflowController {
  constructor(
    private readonly workflow: WorkflowService,
    private readonly writes: WorkflowWriteService,
  ) {}

  /**
   * Readable by any authenticated user, not just admins: the shell paints the --status-*
   * CSS variables from `statusColors`, the board reads `boardColumns` and `wipLimits`, and the
   * issue view needs `transitions` to offer status changes. Gating it would break the UI for
   * everyone below level 90.
   */
  @Get()
  get() {
    return this.workflow.get();
  }

  @Put()
  @Requires('manageWorkflow')
  @UsePipes(new ZodBodyPipe(workflowUpdateSchema))
  replace(@Body() update: WorkflowUpdate, @CurrentUser('id') actorId: number) {
    return this.writes.replace(update, actorId);
  }

  @Post('reset')
  @Requires('manageWorkflow')
  reset(@CurrentUser('id') actorId: number) {
    return this.writes.reset(actorId);
  }
}
