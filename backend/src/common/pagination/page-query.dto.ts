import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Zero-based paging. `pageSize` defaults to the caller's own preference, not a constant. */
export class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  page?: number;

  /**
   * Capped at 200. The frontend offers 10/25/50/100 and "all" (0); "all" is answered with the
   * cap rather than an unbounded query, because a genuinely unbounded list is how a shared
   * server falls over.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(200)
  pageSize?: number;
}

export const MAX_PAGE_SIZE = 200;

export const resolvePaging = (
  query: PageQueryDto,
  preferredPageSize: number,
): { page: number; pageSize: number; offset: number } => {
  const page = query.page ?? 0;
  const requested = query.pageSize ?? preferredPageSize;
  // 0 means "all" in the frontend's page-size selector.
  const pageSize = requested === 0 ? MAX_PAGE_SIZE : Math.min(requested, MAX_PAGE_SIZE);
  return { page, pageSize, offset: page * pageSize };
};
