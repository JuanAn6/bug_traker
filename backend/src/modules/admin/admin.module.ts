import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { IssuesModule } from '../issues/issues.module';
import { AdminController } from './admin.controller';
import { UndoController } from './undo.controller';

@Module({
  imports: [IssuesModule, AttachmentsModule],
  controllers: [AdminController, UndoController],
})
export class AdminModule {}
