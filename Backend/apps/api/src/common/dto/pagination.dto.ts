import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

export enum SortDirection {
  ASC = 'asc',
  DESC = 'desc',
}

/**
 * Offset pagination.
 *
 * Offset rather than cursor: laboratory datasets are small (thousands of
 * samples, not millions), and offset supports the jump-to-page control the
 * dashboard needs. The `limit` ceiling is enforced here so a client cannot
 * request the whole table in one call.
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1, description: '1-based page number.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    default: 20,
    description: 'Items per page. Capped at 100.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({
    enum: SortDirection,
    default: SortDirection.DESC,
    description: 'Sort direction.',
  })
  @IsOptional()
  @IsEnum(SortDirection)
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  sortDirection?: SortDirection = SortDirection.DESC;

  get offset(): number {
    return ((this.page ?? 1) - 1) * (this.limit ?? 20);
  }

  get take(): number {
    return this.limit ?? 20;
  }
}

export class PaginationMeta {
  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 137 })
  total!: number;

  @ApiProperty({ example: 7 })
  totalPages!: number;

  @ApiProperty({ example: true })
  hasNextPage!: boolean;

  @ApiProperty({ example: false })
  hasPreviousPage!: boolean;
}

export interface PaginatedResult<T> {
  data: T[];
  meta: PaginationMeta;
}

export function buildPaginationMeta(
  page: number,
  limit: number,
  total: number,
): PaginationMeta {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1 && total > 0,
  };
}

/**
 * Whitelist-based ORDER BY.
 *
 * The column name is looked up in a map of allowed values and the direction is
 * reduced to one of two literals, so no caller-supplied text ever reaches the
 * SQL string. Column names cannot be bind parameters, which is exactly why
 * this needs to be a whitelist rather than an escape.
 */
export function buildOrderBy(
  requested: string | undefined,
  allowed: Record<string, string>,
  fallbackColumn: string,
  direction: SortDirection = SortDirection.DESC,
): string {
  const column =
    requested && Object.prototype.hasOwnProperty.call(allowed, requested)
      ? allowed[requested]
      : fallbackColumn;
  const order = direction === SortDirection.ASC ? 'ASC' : 'DESC';
  return `${column} ${order}`;
}
