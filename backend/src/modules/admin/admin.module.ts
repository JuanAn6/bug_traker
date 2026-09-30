import { Module } from '@nestjs/common';
import { IssuesModule } from '../issues/issues.module';
import { AdminController } from './admin.controller';
import { UndoController } from './undo.controller';

@Module({
  imports: [IssuesModule],
  controllers: [AdminController, UndoController],
})
export class AdminModule {}
