import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import {
  buildOrderBy,
  buildPaginationMeta,
  PaginatedResult,
} from '../../common/dto/pagination.dto';
import { AuthenticatedUser } from '../../common/types/request-context';
import { AuditAction, AuditService } from '../audit/audit.service';
import { CreateSampleDto, ListSamplesQueryDto, UpdateSampleDto } from './dto/sample.dto';
import { SampleResponse } from './dto/sample.response';

interface SampleRow {
  id: string;
  laboratory_id: string;
  sample_code: string;
  sample_type: string;
  product_name: string | null;
  batch_reference: string | null;
  manufacturer: string | null;
  collected_at: Date | null;
  received_at: Date;
  status: string;
  test_method_id: string | null;
  test_method_code: string | null;
  test_method_name: string | null;
  test_method_validation_status: string | null;
  technician_id: string | null;
  technician_name: string | null;
  preparation_notes: string | null;
  dilution_factor: string | null;
  notes: string | null;
  image_count: string;
  analysis_count: string;
  measurement_count: string;
  created_at: Date;
  updated_at: Date;
}

/** Columns a client may sort by, mapped to real SQL expressions. */
const SORTABLE_COLUMNS: Record<string, string> = {
  createdAt: 's.created_at',
  receivedAt: 's.received_at',
  sampleCode: 's.sample_code',
  status: 's.status',
};

/**
 * Sample registration and retrieval.
 *
 * Every method takes a laboratoryId that LaboratoryScopeGuard has already
 * verified the caller belongs to, and every query filters on it. The RLS
 * policies enforce the same rule at the database; both layers agree.
 */
@Injectable()
export class SamplesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly auditService: AuditService,
  ) {}

  /** Shared projection, so list and detail return identical shapes. */
  private readonly selectClause = `
    SELECT s.id, s.laboratory_id, s.sample_code, s.sample_type,
           s.product_name, s.batch_reference, s.manufacturer,
           s.collected_at, s.received_at, s.status,
           s.test_method_id,
           tm.code AS test_method_code,
           tm.name AS test_method_name,
           tm.validation_status::text AS test_method_validation_status,
           s.technician_id,
           u.full_name AS technician_name,
           s.preparation_notes, s.dilution_factor, s.notes,
           (SELECT COUNT(*) FROM sample_images si WHERE si.sample_id = s.id)::text
             AS image_count,
           (SELECT COUNT(*) FROM analysis_results ar WHERE ar.sample_id = s.id)::text
             AS analysis_count,
           (SELECT COUNT(*) FROM laboratory_measurements lm WHERE lm.sample_id = s.id)::text
             AS measurement_count,
           s.created_at, s.updated_at
      FROM samples s
      LEFT JOIN test_methods tm ON tm.id = s.test_method_id
      LEFT JOIN users u ON u.id = s.technician_id
  `;

  async create(
    dto: CreateSampleDto,
    actor: AuthenticatedUser,
    correlationId?: string,
  ): Promise<SampleResponse> {
    // Validate the method exists and is usable by this laboratory before
    // inserting, so the client gets a clear message rather than an FK error.
    if (dto.testMethodId) {
      await this.assertMethodUsable(dto.testMethodId, dto.laboratoryId);
    }

    const existing = await this.db.queryOne<{ id: string }>(
      'SELECT id FROM samples WHERE laboratory_id = $1 AND sample_code = $2',
      [dto.laboratoryId, dto.sampleCode],
    );
    if (existing) {
      throw ApiError.conflict(
        ErrorCode.ALREADY_EXISTS,
        `Sample code "${dto.sampleCode}" is already in use in this laboratory`,
      );
    }

    const row = await this.db.queryOne<{ id: string }>(
      `INSERT INTO samples (
         laboratory_id, sample_code, sample_type, product_name, batch_reference,
         manufacturer, collected_at, technician_id, test_method_id,
         preparation_notes, dilution_factor, notes, status, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'REGISTERED',$8)
       RETURNING id`,
      [
        dto.laboratoryId,
        dto.sampleCode,
        dto.sampleType,
        dto.productName ?? null,
        dto.batchReference ?? null,
        dto.manufacturer ?? null,
        dto.collectedAt ?? null,
        actor.id,
        dto.testMethodId ?? null,
        dto.preparationNotes ?? null,
        dto.dilutionFactor ?? null,
        dto.notes ?? null,
      ],
    );

    if (!row) throw ApiError.internal('Failed to create the sample');

    await this.auditService.record({
      actorUserId: actor.id,
      actorEmail: actor.email,
      laboratoryId: dto.laboratoryId,
      action: AuditAction.SAMPLE_CREATE,
      resourceType: 'sample',
      resourceId: row.id,
      correlationId,
      metadata: { sampleCode: dto.sampleCode, sampleType: dto.sampleType },
    });

    return this.findOne(row.id, dto.laboratoryId);
  }

  async list(query: ListSamplesQueryDto): Promise<PaginatedResult<SampleResponse>> {
    const filters: string[] = ['s.laboratory_id = $1'];
    const params: unknown[] = [query.laboratoryId];

    if (query.search) {
      params.push(`%${query.search}%`);
      // ILIKE across the three human-facing identifiers. Parameterised, so
      // wildcards in the search term are matched literally by the driver.
      filters.push(
        `(s.sample_code ILIKE $${params.length}
          OR s.product_name ILIKE $${params.length}
          OR s.batch_reference ILIKE $${params.length})`,
      );
    }
    if (query.status) {
      params.push(query.status);
      filters.push(`s.status = $${params.length}::sample_status`);
    }
    if (query.sampleType) {
      params.push(query.sampleType);
      filters.push(`s.sample_type = $${params.length}`);
    }
    if (query.testMethodId) {
      params.push(query.testMethodId);
      filters.push(`s.test_method_id = $${params.length}`);
    }
    if (query.receivedFrom) {
      params.push(query.receivedFrom);
      filters.push(`s.received_at >= $${params.length}`);
    }
    if (query.receivedTo) {
      params.push(query.receivedTo);
      filters.push(`s.received_at <= $${params.length}`);
    }

    const where = filters.join(' AND ');

    const totalRow = await this.db.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM samples s WHERE ${where}`,
      params,
    );
    const total = Number(totalRow?.count ?? 0);

    const orderBy = buildOrderBy(
      query.sortBy,
      SORTABLE_COLUMNS,
      's.created_at',
      query.sortDirection,
    );

    params.push(query.take, query.offset);
    const rows = await this.db.query<SampleRow>(
      `${this.selectClause}
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      data: rows.map((row) => this.toResponse(row)),
      meta: buildPaginationMeta(query.page ?? 1, query.take, total),
    };
  }

  async findOne(id: string, laboratoryId: string): Promise<SampleResponse> {
    const row = await this.db.queryOne<SampleRow>(
      `${this.selectClause} WHERE s.id = $1 AND s.laboratory_id = $2`,
      [id, laboratoryId],
    );
    if (!row) throw ApiError.notFound('Sample');
    return this.toResponse(row);
  }

  /** Resolves the owning laboratory, for routes keyed only by sample id. */
  async resolveLaboratoryId(sampleId: string): Promise<string> {
    const row = await this.db.queryOne<{ laboratory_id: string }>(
      'SELECT laboratory_id FROM samples WHERE id = $1',
      [sampleId],
    );
    if (!row) throw ApiError.notFound('Sample');
    return row.laboratory_id;
  }

  async update(
    id: string,
    laboratoryId: string,
    dto: UpdateSampleDto,
    actor: AuthenticatedUser,
    correlationId?: string,
  ): Promise<SampleResponse> {
    await this.findOne(id, laboratoryId);

    if (dto.testMethodId) {
      await this.assertMethodUsable(dto.testMethodId, laboratoryId);
    }

    // Build the SET list from declared fields only. The DTO's whitelist
    // already rejects unknown properties; this map is the second gate, so a
    // client cannot reach a column that is not explicitly updatable.
    const assignable: Record<string, unknown> = {
      sample_type: dto.sampleType,
      product_name: dto.productName,
      batch_reference: dto.batchReference,
      manufacturer: dto.manufacturer,
      test_method_id: dto.testMethodId,
      preparation_notes: dto.preparationNotes,
      dilution_factor: dto.dilutionFactor,
      notes: dto.notes,
    };

    const updates: string[] = [];
    const params: unknown[] = [id, laboratoryId];

    for (const [column, value] of Object.entries(assignable)) {
      if (value !== undefined) {
        params.push(value);
        updates.push(`${column} = $${params.length}`);
      }
    }

    if (dto.status !== undefined) {
      params.push(dto.status);
      updates.push(`status = $${params.length}::sample_status`);
    }

    if (updates.length === 0) {
      return this.findOne(id, laboratoryId);
    }

    await this.db.query(
      `UPDATE samples SET ${updates.join(', ')}
        WHERE id = $1 AND laboratory_id = $2`,
      params,
    );

    await this.auditService.record({
      actorUserId: actor.id,
      actorEmail: actor.email,
      laboratoryId,
      action: AuditAction.SAMPLE_UPDATE,
      resourceType: 'sample',
      resourceId: id,
      correlationId,
      metadata: {
        fields: Object.keys(assignable).filter((key) => assignable[key] !== undefined),
      },
    });

    return this.findOne(id, laboratoryId);
  }

  /**
   * A method is usable when it is active and either platform-wide or owned by
   * this laboratory. Prevents one laboratory from attaching another's method.
   */
  private async assertMethodUsable(
    testMethodId: string,
    laboratoryId: string,
  ): Promise<void> {
    const method = await this.db.queryOne<{ id: string; is_active: boolean }>(
      `SELECT id, is_active FROM test_methods
        WHERE id = $1 AND (laboratory_id IS NULL OR laboratory_id = $2)`,
      [testMethodId, laboratoryId],
    );
    if (!method) throw ApiError.notFound('Test method');
    if (!method.is_active) {
      throw ApiError.badRequest(
        ErrorCode.CONFLICTING_STATE,
        'That test method is archived and cannot be assigned to new samples',
      );
    }
  }

  private toResponse(row: SampleRow): SampleResponse {
    return {
      id: row.id,
      laboratoryId: row.laboratory_id,
      sampleCode: row.sample_code,
      sampleType: row.sample_type,
      productName: row.product_name,
      batchReference: row.batch_reference,
      manufacturer: row.manufacturer,
      collectedAt: row.collected_at?.toISOString() ?? null,
      receivedAt: row.received_at.toISOString(),
      status: row.status as SampleResponse['status'],
      testMethodId: row.test_method_id,
      testMethodCode: row.test_method_code,
      testMethodName: row.test_method_name,
      testMethodValidationStatus: row.test_method_validation_status,
      technicianId: row.technician_id,
      technicianName: row.technician_name,
      preparationNotes: row.preparation_notes,
      // numeric comes back as a string from pg; convert at the boundary.
      dilutionFactor: row.dilution_factor ? Number(row.dilution_factor) : null,
      notes: row.notes,
      imageCount: Number(row.image_count),
      analysisCount: Number(row.analysis_count),
      measurementCount: Number(row.measurement_count),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }
}
