import { Global, Module } from '@nestjs/common';
import { ProjectTreeService } from './project-tree/project-tree.service';
import { WorkflowService } from './workflow/workflow.service';

/**
 * The two caches that almost everything depends on.
 *
 * They live in a @Global() module rather than in AppModule's providers because Nest does not
 * pass a module's own providers down into the modules it imports: AuthModule needs
 * WorkflowService for every permission check, and would not see it otherwise.
 */
@Global()
@Module({
  providers: [WorkflowService, ProjectTreeService],
  exports: [WorkflowService, ProjectTreeService],
})
export class CoreModule {}
