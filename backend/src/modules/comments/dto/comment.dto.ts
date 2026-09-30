import { IsBoolean, IsInt, IsObject, IsOptional, Min } from 'class-validator';
import type { RichText } from '../../../shared/models';

export class CreateNoteDto {
  @IsObject()
  body!: RichText;

  @IsOptional() @IsBoolean()
  private?: boolean;

  /** Minutes. The time-tracking summary sums these per author. */
  @IsOptional() @IsInt() @Min(0)
  timeSpent?: number;

  /** Pending uploads to attach to this note. Verified to belong to the caller. */
  @IsOptional() @IsInt({ each: true })
  attachmentIds?: number[];
}

export class UpdateNoteDto {
  @IsOptional() @IsObject()
  body?: RichText;

  @IsOptional() @IsBoolean()
  private?: boolean;

  @IsOptional() @IsInt() @Min(0)
  timeSpent?: number;
}
