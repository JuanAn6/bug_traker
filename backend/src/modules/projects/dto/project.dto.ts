import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Matches,
  MaxLength, Min, ValidateNested,
} from 'class-validator';
import { PROJECT_STATUSES } from '../../../shared/config';
import type { RichText } from '../../../shared/models';

/** The frontend's own rule: a letter then 1-9 alphanumerics. */
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{1,9}$/;

export class CategoryDto {
  @IsString() @MaxLength(64)
  name!: string;

  /** Applied to new issues in this category when the reporter names no handler. */
  @IsOptional() @IsInt()
  defaultHandlerId?: number | null;

  /**
   * The name this category had before the edit. Present only when renaming — the server uses it
   * to rewrite `issues.category`, since categories are matched by name and a rename would
   * otherwise orphan every issue that used the old one.
   */
  @IsOptional() @IsString() @MaxLength(64)
  previousName?: string;
}

export class VersionDto {
  @IsString() @MaxLength(64)
  name!: string;

  @IsOptional() @IsString()
  date?: string | null;

  @IsOptional() @IsBoolean() released?: boolean;
  @IsOptional() @IsBoolean() obsolete?: boolean;
  @IsOptional() @IsString() @MaxLength(512) description?: string;

  /** As for categories: set when renaming, so the three version columns can be rewritten. */
  @IsOptional() @IsString() @MaxLength(64)
  previousName?: string;
}

export class MemberDto {
  @IsInt() @Min(1)
  userId!: number;

  /** Replaces the user's global level inside this project — it may lower it. */
  @IsIn([10, 25, 40, 55, 70, 90])
  accessLevel!: number;
}

export class CreateProjectDto {
  @IsString() @MaxLength(128)
  name!: string;

  @Matches(KEY_PATTERN, { message: 'key must be a letter followed by 1-9 alphanumerics' })
  key!: string;

  @IsOptional() @IsObject()
  description?: RichText;

  @IsOptional() @IsIn(PROJECT_STATUSES)
  status?: (typeof PROJECT_STATUSES)[number];

  @IsOptional() @IsIn(['public', 'private'])
  viewState?: 'public' | 'private';

  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() parentId?: number | null;
}

/**
 * A whole-project save, the shape the project-edit page produces.
 *
 * Categories and versions arrive as complete lists: what is absent is deleted. That is why each
 * entry can carry `previousName` — without it a rename is indistinguishable from a delete plus
 * an add, and every issue referencing the old name would be silently orphaned.
 */
export class UpdateProjectDto {
  @IsOptional() @IsString() @MaxLength(128) name?: string;
  @IsOptional() @Matches(KEY_PATTERN) key?: string;
  @IsOptional() @IsObject() description?: RichText;
  @IsOptional() @IsIn(PROJECT_STATUSES) status?: (typeof PROJECT_STATUSES)[number];
  @IsOptional() @IsIn(['public', 'private']) viewState?: 'public' | 'private';
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() parentId?: number | null;

  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => CategoryDto)
  categories?: CategoryDto[];

  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => VersionDto)
  versions?: VersionDto[];

  @IsOptional() @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => MemberDto)
  members?: MemberDto[];

  @IsOptional() @IsArray() @IsInt({ each: true })
  customFieldIds?: number[];

  /**
   * Where issues of a deleted category go. Required when the category still has issues: the
   * project-edit page forces the user to choose, because silently moving them to the first
   * category would be a surprise.
   */
  @IsOptional() @IsObject()
  categoryMerges?: Record<string, string>;
}

export class ReorderVersionsDto {
  @IsArray() @IsString({ each: true })
  names!: string[];
}

export { KEY_PATTERN };
