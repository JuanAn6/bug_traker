import { Type } from 'class-transformer';
import {
  IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, MaxLength, Min,
} from 'class-validator';
import {
  PRIORITIES, REPRODUCIBILITY, RESOLUTIONS, SEVERITIES, STATUSES,
} from '../../../shared/config';
import type { RichText } from '../../../shared/models';

export class CreateIssueDto {
  @IsInt() @Min(1)
  projectId!: number;

  @IsString() @MaxLength(64)
  category!: string;

  /** 128 is the frontend's own limit; the column is wider so the truncation is explicit. */
  @IsString() @MaxLength(128)
  summary!: string;

  @IsOptional() @IsObject()
  description?: RichText;

  @IsOptional() @IsObject()
  stepsToReproduce?: RichText;

  @IsOptional() @IsObject()
  additionalInfo?: RichText;

  @IsOptional() @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];

  @IsOptional() @IsIn(RESOLUTIONS)
  resolution?: (typeof RESOLUTIONS)[number];

  @IsOptional() @IsIn(PRIORITIES)
  priority?: (typeof PRIORITIES)[number];

  @IsOptional() @IsIn(SEVERITIES)
  severity?: (typeof SEVERITIES)[number];

  @IsOptional() @IsIn(REPRODUCIBILITY)
  reproducibility?: (typeof REPRODUCIBILITY)[number];

  @IsOptional() @IsString() @MaxLength(64) platform?: string;
  @IsOptional() @IsString() @MaxLength(64) os?: string;
  @IsOptional() @IsString() @MaxLength(64) osBuild?: string;
  @IsOptional() @IsString() @MaxLength(64) productVersion?: string;
  @IsOptional() @IsString() @MaxLength(64) targetVersion?: string;
  @IsOptional() @IsString() @MaxLength(64) fixedInVersion?: string;

  @IsOptional() @IsInt() sprintId?: number | null;
  @IsOptional() @IsInt() handlerId?: number | null;

  @IsOptional() @IsIn(['public', 'private'])
  viewState?: 'public' | 'private';

  @IsOptional() @IsString()
  dueDate?: string | null;

  @IsOptional() @IsNumber() estimate?: number | null;
  @IsOptional() @IsInt() storyPoints?: number | null;

  @IsOptional() @IsArray() @IsString({ each: true })
  tags?: string[];

  @IsOptional() @IsObject()
  customFields?: Record<number, string>;

  /** Honoured only for callers holding `manageUsers` — see the service. */
  @IsOptional() @IsInt()
  reporterId?: number;

  /** Pending uploads to adopt. Verified to belong to the caller before they are attached. */
  @IsOptional() @IsArray() @IsInt({ each: true })
  attachmentIds?: number[];
}

/**
 * A generic patch. Which fields the caller may actually touch is decided in the service
 * against the runtime thresholds, not here: `projectId` needs `move`, `handlerId` needs
 * `assign`, `status` needs `changeStatus` plus a legal transition.
 */
export class UpdateIssueDto {
  @IsOptional() @IsString() @MaxLength(128) summary?: string;
  @IsOptional() @IsObject() description?: RichText;
  @IsOptional() @IsObject() stepsToReproduce?: RichText;
  @IsOptional() @IsObject() additionalInfo?: RichText;
  @IsOptional() @IsString() @MaxLength(64) category?: string;
  @IsOptional() @IsIn(PRIORITIES) priority?: (typeof PRIORITIES)[number];
  @IsOptional() @IsIn(SEVERITIES) severity?: (typeof SEVERITIES)[number];
  @IsOptional() @IsIn(REPRODUCIBILITY) reproducibility?: (typeof REPRODUCIBILITY)[number];
  @IsOptional() @IsIn(STATUSES) status?: (typeof STATUSES)[number];
  // No `resolution` here on purpose: applyPatch derives it when the status crosses the resolved
  // boundary, and setting it explicitly is what POST /issues/:id/status is for.
  @IsOptional() @IsString() @MaxLength(64) platform?: string;
  @IsOptional() @IsString() @MaxLength(64) os?: string;
  @IsOptional() @IsString() @MaxLength(64) osBuild?: string;
  @IsOptional() @IsString() @MaxLength(64) productVersion?: string;
  @IsOptional() @IsString() @MaxLength(64) targetVersion?: string;
  @IsOptional() @IsString() @MaxLength(64) fixedInVersion?: string;
  @IsOptional() @IsInt() sprintId?: number | null;
  @IsOptional() @IsInt() handlerId?: number | null;
  @IsOptional() @IsInt() projectId?: number;
  @IsOptional() @IsIn(['public', 'private']) viewState?: 'public' | 'private';
  @IsOptional() @IsBoolean() sticky?: boolean;
  @IsOptional() @IsString() dueDate?: string | null;
  @IsOptional() @IsNumber() estimate?: number | null;
  @IsOptional() @IsInt() storyPoints?: number | null;

  /**
   * Optimistic concurrency. Send the rowVersion from the GET and a concurrent edit loses with
   * 409 instead of silently overwriting; omit it and last-write-wins.
   */
  @IsOptional() @Type(() => Number) @IsInt()
  rowVersion?: number;
}

export class ChangeStatusDto {
  @IsIn(STATUSES)
  status!: (typeof STATUSES)[number];

  @IsOptional() @IsIn(RESOLUTIONS)
  resolution?: (typeof RESOLUTIONS)[number];

  @IsOptional() @IsString() @MaxLength(64)
  fixedInVersion?: string;

  @IsOptional() @IsInt()
  handlerId?: number | null;

  /** An optional note posted atomically with the change, as the resolve dialog does. */
  @IsOptional() @IsObject()
  note?: RichText;

  @IsOptional() @IsBoolean()
  notePrivate?: boolean;

  @IsOptional() @IsInt() @Min(0)
  timeSpent?: number;
}
