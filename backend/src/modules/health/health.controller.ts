import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { DrizzleService } from '../../core/database/drizzle.service';
import { WorkflowService } from '../../core/workflow/workflow.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly workflow: WorkflowService,
  ) {}

  /** Liveness: the process is up. No dependencies touched. */
  @Public()
  @Get()
  live() {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }

  /**
   * Readiness: the database answers, the workflow row exists, and the search indexes the
   * configured driver expects are present. A green /health with a red /health/ready is
   * exactly the distinction a load balancer needs.
   */
  @Public()
  @Get('ready')
  async ready() {
    const [wf, fulltext] = await Promise.all([
      this.workflow.get().then(() => true).catch(() => false),
      this.drizzle.hasFulltextIndexes().catch(() => false),
    ]);
    return { status: wf ? 'ok' : 'degraded', workflow: wf, fulltextIndexes: fulltext };
  }
}
