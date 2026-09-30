import { Module } from '@nestjs/common';
import { IssuesModule } from '../issues/issues.module';
import { UndoController } from './undo.controller';

@Module({
  imports: [IssuesModule],
  controllers: [UndoController],
})
export class AdminModule {}
