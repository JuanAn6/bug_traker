import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { PRIORITIES, RELATIONSHIPS, SEVERITIES, STATUSES } from '../../../shared/config';

/** Bounded so one request cannot ask the server to lock the whole table. */
class IdsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(1000) @IsInt({ each: true })
  ids!: number[];
}

export class BulkStatusDto extends IdsDto {
  @IsIn(STATUSES)
  status!: (typeof STATUSES)[number];
}

export class BulkAssignDto extends IdsDto {
  /** null unassigns. */
  @IsOptional() @IsInt()
  handlerId?: number | null;
}

export class BulkMoveDto extends IdsDto {
  @IsInt() @Min(1)
  projectId!: number;
}

export class BulkPatchDto extends IdsDto {
  @IsOptional() @IsIn(PRIORITIES) priority?: (typeof PRIORITIES)[number];
  @IsOptional() @IsIn(SEVERITIES) severity?: (typeof SEVERITIES)[number];
  @IsOptional() @IsInt() sprintId?: number | null;
  @IsOptional() @IsString() @MaxLength(64) targetVersion?: string;
  @IsOptional() @IsString() @MaxLength(64) category?: string;
  @IsOptional() @IsBoolean() sticky?: boolean;
}

export class BulkDeleteDto extends IdsDto {}

export class CloneIssueDto {
  @IsOptional() @IsBoolean() copyNotes?: boolean;
  @IsOptional() @IsBoolean() copyAttachments?: boolean;
}

export class RelationshipDto {
  @IsIn(RELATIONSHIPS)
  type!: (typeof RELATIONSHIPS)[number];

  @IsInt() @Min(1)
  issueId!: number;
}

export class MonitorDto {
  /** Omitted means the caller themselves, which needs no extra permission. */
  @IsOptional() @IsInt()
  userId?: number;

  @IsBoolean()
  on!: boolean;
}

export class TagDto {
  /** Normalized server-side: trim, lowercase, hyphenate. */
  @IsString() @MaxLength(64)
  tag!: string;
}
