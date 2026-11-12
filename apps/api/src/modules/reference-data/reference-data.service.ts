import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { buildPaginationMeta, PaginatedResult } from '../../common/dto/pagination.dto';
import { rgbToLab } from '../../common/color/color-conversion';
import { AuthenticatedUser } from '../../common/types/request-context';
import { Permission, roleHasPermission, UserRole } from '../../common/types/roles';
import { AuditAction, AuditService } from '../audit/audit.service';
import {
  CreateReferenceChartDto,
  CreateReferenceLevelDto,
  CreateTestMethodDto,
  ListReferenceChartsQueryDto,
  ListTestMethodsQueryDto,
  UpdateReferenceChartDto,
  UpdateReferenceLevelDto,
  UpdateTestMethodDto,
  ValidationStatus,
} from './dto/reference.dto';

/**
 * Test methods and reference charts.
 *
 * The rule this service exists to enforce: **validation status must be
 * earned.** Marking anything VALIDATED requires the `reference:validate`
 * capability and records who did it and when. A chart whose colours were read
 * off a picture defaults to ILLUSTRATIVE and stays there until a human with
 * authority says otherwise — and the analysis pipeline reads that status when
 * deciding what it is allowed to report.
 */
@Injectable()
export class ReferenceDataService {
  private readonly logger = new Logger(ReferenceDataService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly auditService: AuditService,
  ) {}

  // ── Test methods ──────────────────────────────────────────────────────────

  async createTestMethod(
    dto: CreateTestMethodDto,
    actor: AuthenticatedUser,
    correlationId?: string,
  ): Promise<Record<string, unknown>> {
    // A platform-wide method (no laboratory) affects every laboratory, so it
    // is restricted to SUPER_ADMIN.
    if (!dto.laboratoryId && actor.role !== UserRole.SUPER_ADMIN) {
      throw ApiError.forbidden(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        'Only a platform administrator can create a platform-wide test method. ' +
          'Supply laboratoryId to create one for your laboratory.',
      );
    }

    const row = await this.db.queryOne<{ id: string }>(
      `INSERT INTO test_methods (
         laboratory_id, code, name, target_analyte, description,
         procedure_reference, applicable_matrix, reagent_notes, method_version,
         concentration_unit, limit_of_detection, limit_of_quantitation,
         validation_status, validation_notes, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'DRAFT',$13,$14)
       RETURNING id`,
      [
        dto.laboratoryId ?? null,
        dto.code,
        dto.name,
        dto.targetAnalyte,
        dto.description ?? null,
        dto.procedureReference ?? null,
        dto.applicableMatrix,
        dto.reagentNotes ?? null,
        dto.methodVersion ?? '1.0.0',
        dto.concentrationUnit ?? 'ppm',
        dto.limitOfDetection ?? null,
        dto.limitOfQuantitation ?? null,
        dto.validationNotes ?? null,
        actor.id,
      ],
    );
    if (!row) throw ApiError.internal('Failed to create the test method');

    await this.auditService.record({
      actorUserId: actor.id,
      actorEmail: actor.email,
      laboratoryId: dto.laboratoryId ?? null,
      action: AuditAction.METHOD_CREATE,
      resourceType: 'test_method',
      resourceId: row.id,
      correlationId,
      metadata: { code: dto.code, targetAnalyte: dto.targetAnalyte },
    });

    return this.getTestMethod(row.id);
  }

  async listTestMethods(
    query: ListTestMethodsQueryDto,
    actor: AuthenticatedUser,
  ): Promise<PaginatedResult<Record<string, unknown>>> {
    const params: unknown[] = [];
    const filters: string[] = [];

    if (query.laboratoryId) {
      // Platform-wide methods are visible alongside the laboratory's own.
      params.push(query.laboratoryId);
      filters.push(`(tm.laboratory_id IS NULL OR tm.laboratory_id = $${params.length})`);
    } else if (actor.role !== UserRole.SUPER_ADMIN) {
      const labIds = actor.memberships.map((m) => m.laboratoryId);
      if (labIds.length === 0) {
        filters.push('tm.laboratory_id IS NULL');
      } else {
        params.push(labIds);
        filters.push(
          `(tm.laboratory_id IS NULL OR tm.laboratory_id = ANY($${params.length}::uuid[]))`,
        );
      }
    }

    if (query.validationStatus) {
      params.push(query.validationStatus);
      filters.push(`tm.validation_status = $${params.length}::validation_status`);
    }
    if (query.activeOnly !== false) {
      filters.push('tm.is_active');
    }
    if (query.search) {
      params.push(`%${query.search}%`);
      filters.push(
        `(tm.name ILIKE $${params.length} OR tm.code ILIKE $${params.length}
          OR tm.target_analyte ILIKE $${params.length})`,
      );
    }

    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    const totalRow = await this.db.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM test_methods tm ${where}`,
      params,
    );
    const total = Number(totalRow?.count ?? 0);

    params.push(query.take, query.offset);
    const rows = await this.db.query(
      `SELECT tm.*,
              (SELECT COUNT(*) FROM reference_charts rc
                WHERE rc.test_method_id = tm.id AND rc.is_active)::text AS chart_count
         FROM test_methods tm
         ${where}
        ORDER BY tm.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      data: rows.map((row) => this.mapTestMethod(row)),
      meta: buildPaginationMeta(query.page ?? 1, query.take, total),
    };
  }

  async getTestMethod(id: string): Promise<Record<string, unknown>> {
    const row = await this.db.queryOne(
      `SELECT tm.*,
              (SELECT COUNT(*) FROM reference_charts rc
                WHERE rc.test_method_id = tm.id AND rc.is_active)::text AS chart_count
         FROM test_methods tm WHERE tm.id = $1`,
      [id],
    );
    if (!row) throw ApiError.notFound('Test method');
    return this.mapTestMethod(row);
  }

  async updateTestMethod(
    id: string,
    dto: UpdateTestMethodDto,
    actor: AuthenticatedUser,
    effectiveRole: UserRole,
    correlationId?: string,
  ): Promise<Record<string, unknown>> {
    const existing = await this.db.queryOne<{
      id: string;
      laboratory_id: string | null;
      validation_status: string;
    }>(
      `SELECT id, laboratory_id, validation_status::text AS validation_status
         FROM test_methods WHERE id = $1`,
      [id],
    );
    if (!existing) throw ApiError.notFound('Test method');

    const params: unknown[] = [id];
    const updates: string[] = [];

    const assignable: Record<string, unknown> = {
      name: dto.name,
      description: dto.description,
      procedure_reference: dto.procedureReference,
      reagent_notes: dto.reagentNotes,
      applicable_matrix: dto.applicableMatrix,
      limit_of_detection: dto.limitOfDetection,
      limit_of_quantitation: dto.limitOfQuantitation,
      validation_notes: dto.validationNotes,
      is_active: dto.isActive,
    };

    for (const [column, value] of Object.entries(assignable)) {
      if (value !== undefined) {
        params.push(value);
        updates.push(`${column} = $${params.length}`);
      }
    }

    if (dto.validationStatus !== undefined) {
      this.assertMayChangeValidation(dto.validationStatus, effectiveRole);

      params.push(dto.validationStatus);
      updates.push(`validation_status = $${params.length}::validation_status`);

      if (dto.validationStatus === ValidationStatus.VALIDATED) {
        // The schema requires an attributed reviewer for VALIDATED; record
        // who made the call and when.
        params.push(actor.id);
        updates.push(`validated_by = $${params.length}`);
        updates.push('validated_at = now()');
      }
    }

    if (updates.length === 0) return this.getTestMethod(id);

    await this.db.query(
      `UPDATE test_methods SET ${updates.join(', ')} WHERE id = $1`,
      params,
    );

    await this.auditService.record({
      actorUserId: actor.id,
      actorEmail: actor.email,
      laboratoryId: existing.laboratory_id,
      action: AuditAction.METHOD_UPDATE,
      resourceType: 'test_method',
      resourceId: id,
      correlationId,
      metadata: {
        previousValidationStatus: existing.validation_status,
        newValidationStatus: dto.validationStatus ?? existing.validation_status,
      },
    });

    return this.getTestMethod(id);
  }

  // ── Reference charts ──────────────────────────────────────────────────────

  async createChart(
    dto: CreateReferenceChartDto,
    actor: AuthenticatedUser,
    effectiveRole: UserRole,
    correlationId?: string,
  ): Promise<Record<string, unknown>> {
    const method = await this.db.queryOne<{ id: string; concentration_unit: string }>(
      'SELECT id, concentration_unit FROM test_methods WHERE id = $1',
      [dto.testMethodId],
    );
    if (!method) throw ApiError.notFound('Test method');

    if (dto.validationStatus) {
      this.assertMayChangeValidation(dto.validationStatus, effectiveRole);
    }

    // Version follows the highest existing version for this method+name.
    const versionRow = await this.db.queryOne<{ next_version: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM reference_charts WHERE test_method_id = $1 AND name = $2`,
      [dto.testMethodId, dto.name],
    );
    const version = versionRow?.next_version ?? 1;

    return this.db.transaction(async (client) => {
      const chartRows = await client.query<{ id: string }>(
        `INSERT INTO reference_charts (
           test_method_id, laboratory_id, name, description, source, source_url,
           illuminant, capture_device, version, validation_status,
           chart_image_id, supersedes_id, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::validation_status,$11,$12,$13)
         RETURNING id`,
        [
          dto.testMethodId,
          dto.laboratoryId ?? null,
          dto.name,
          dto.description ?? null,
          dto.source ?? null,
          dto.sourceUrl ?? null,
          dto.illuminant ?? null,
          dto.captureDevice ?? null,
          version,
          dto.validationStatus ?? ValidationStatus.ILLUSTRATIVE,
          dto.chartImageId ?? null,
          dto.supersedesId ?? null,
          actor.id,
        ],
      );
      const chartId = chartRows.rows[0].id;

      if (dto.levels?.length) {
        for (const level of dto.levels) {
          await this.insertLevel(client, chartId, level, method.concentration_unit);
        }
      }

      // Archiving the superseded chart keeps historical results pointing at
      // the version that actually produced them.
      if (dto.supersedesId) {
        await client.query(
          `UPDATE reference_charts SET is_active = false WHERE id = $1`,
          [dto.supersedesId],
        );
      }

      await this.auditService.record({
        actorUserId: actor.id,
        actorEmail: actor.email,
        laboratoryId: dto.laboratoryId ?? null,
        action: AuditAction.CHART_CREATE,
        resourceType: 'reference_chart',
        resourceId: chartId,
        correlationId,
        metadata: {
          name: dto.name,
          version,
          levelCount: dto.levels?.length ?? 0,
          validationStatus: dto.validationStatus ?? ValidationStatus.ILLUSTRATIVE,
        },
      });

      return this.getChart(chartId);
    });
  }

  /**
   * Inserts a level, deriving CIELAB from RGB when Lab was not supplied.
   *
   * Lab is what the matcher uses, so a level without it cannot participate.
   * Converting here rather than rejecting lets a user enter a colour the way
   * they have it (usually RGB from a colour picker) without losing the
   * ability to match.
   */
  private async insertLevel(
    client: { query: (text: string, params: unknown[]) => Promise<unknown> },
    chartId: string,
    level: CreateReferenceLevelDto,
    defaultUnit: string,
  ): Promise<void> {
    let { labL, labA, labB } = level;

    const hasRgb =
      level.rgbR !== undefined && level.rgbG !== undefined && level.rgbB !== undefined;
    const hasLab = labL !== undefined && labA !== undefined && labB !== undefined;

    if (!hasLab && hasRgb) {
      const [l, a, b] = rgbToLab([level.rgbR!, level.rgbG!, level.rgbB!]);
      labL = Number(l.toFixed(4));
      labA = Number(a.toFixed(4));
      labB = Number(b.toFixed(4));
    }

    if (!hasLab && !hasRgb) {
      throw ApiError.badRequest(
        ErrorCode.REFERENCE_DATA_INCOMPLETE,
        `Reference level "${level.label}" has no colour. Supply either RGB ` +
          'or CIELAB values, otherwise it cannot be used for matching.',
      );
    }

    await client.query(
      `INSERT INTO reference_levels (
         reference_chart_id, label, concentration_value, concentration_unit,
         sort_order, rgb_r, rgb_g, rgb_b, lab_l, lab_a, lab_b, lab_std,
         roi_x, roi_y, roi_width, roi_height, color_source, validation_status, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 $17,'ILLUSTRATIVE',$18)`,
      [
        chartId,
        level.label,
        level.concentrationValue ?? null,
        level.concentrationUnit ?? defaultUnit,
        level.sortOrder,
        level.rgbR ?? null,
        level.rgbG ?? null,
        level.rgbB ?? null,
        labL ?? null,
        labA ?? null,
        labB ?? null,
        level.labStd ?? null,
        level.roiX ?? null,
        level.roiY ?? null,
        level.roiWidth ?? null,
        level.roiHeight ?? null,
        level.colorSource ?? 'MANUAL_ENTRY',
        level.notes ?? null,
      ],
    );
  }

  async addLevel(
    chartId: string,
    dto: CreateReferenceLevelDto,
    actor: AuthenticatedUser,
    correlationId?: string,
  ): Promise<Record<string, unknown>> {
    const chart = await this.db.queryOne<{
      id: string;
      laboratory_id: string | null;
      test_method_id: string;
    }>('SELECT id, laboratory_id, test_method_id FROM reference_charts WHERE id = $1', [
      chartId,
    ]);
    if (!chart) throw ApiError.notFound('Reference chart');

    const method = await this.db.queryOne<{ concentration_unit: string }>(
      'SELECT concentration_unit FROM test_methods WHERE id = $1',
      [chart.test_method_id],
    );

    await this.db.transaction(async (client) => {
      await this.insertLevel(client, chartId, dto, method?.concentration_unit ?? 'ppm');
    });

    await this.auditService.record({
      actorUserId: actor.id,
      actorEmail: actor.email,
      laboratoryId: chart.laboratory_id,
      action: AuditAction.LEVEL_CREATE,
      resourceType: 'reference_chart',
      resourceId: chartId,
      correlationId,
      metadata: { label: dto.label, sortOrder: dto.sortOrder },
    });

    return this.getChart(chartId);
  }

  async updateLevel(
    levelId: string,
    dto: UpdateReferenceLevelDto,
    actor: AuthenticatedUser,
    effectiveRole: UserRole,
    correlationId?: string,
  ): Promise<Record<string, unknown>> {
    const level = await this.db.queryOne<{
      id: string;
      reference_chart_id: string;
      laboratory_id: string | null;
    }>(
      `SELECT rl.id, rl.reference_chart_id, rc.laboratory_id
         FROM reference_levels rl
         JOIN reference_charts rc ON rc.id = rl.reference_chart_id
        WHERE rl.id = $1`,
      [levelId],
    );
    if (!level) throw ApiError.notFound('Reference level');

    if (dto.validationStatus !== undefined) {
      this.assertMayChangeValidation(dto.validationStatus, effectiveRole);
    }

    const params: unknown[] = [levelId];
    const updates: string[] = [];

    const assignable: Record<string, unknown> = {
      label: dto.label,
      concentration_value: dto.concentrationValue,
      rgb_r: dto.rgbR,
      rgb_g: dto.rgbG,
      rgb_b: dto.rgbB,
      lab_std: dto.labStd,
      notes: dto.notes,
    };

    for (const [column, value] of Object.entries(assignable)) {
      if (value !== undefined) {
        params.push(value);
        updates.push(`${column} = $${params.length}`);
      }
    }

    // Lab values move together or not at all — the schema's CHECK requires
    // all three or none.
    let labL = dto.labL;
    let labA = dto.labA;
    let labB = dto.labB;

    const rgbChanged =
      dto.rgbR !== undefined && dto.rgbG !== undefined && dto.rgbB !== undefined;
    const labSupplied = labL !== undefined && labA !== undefined && labB !== undefined;

    if (!labSupplied && rgbChanged) {
      const [l, a, b] = rgbToLab([dto.rgbR!, dto.rgbG!, dto.rgbB!]);
      labL = Number(l.toFixed(4));
      labA = Number(a.toFixed(4));
      labB = Number(b.toFixed(4));
    }

    if (labL !== undefined && labA !== undefined && labB !== undefined) {
      params.push(labL, labA, labB);
      updates.push(
        `lab_l = $${params.length - 2}`,
        `lab_a = $${params.length - 1}`,
        `lab_b = $${params.length}`,
      );
    }

    if (dto.colorSource !== undefined) {
      params.push(dto.colorSource);
      updates.push(`color_source = $${params.length}`);
    }
    if (dto.validationStatus !== undefined) {
      params.push(dto.validationStatus);
      updates.push(`validation_status = $${params.length}::validation_status`);
    }

    if (updates.length === 0) return this.getChart(level.reference_chart_id);

    await this.db.query(
      `UPDATE reference_levels SET ${updates.join(', ')} WHERE id = $1`,
      params,
    );

    await this.auditService.record({
      actorUserId: actor.id,
      actorEmail: actor.email,
      laboratoryId: level.laboratory_id,
      action: AuditAction.LEVEL_UPDATE,
      resourceType: 'reference_level',
      resourceId: levelId,
      correlationId,
      metadata: { fields: updates.length },
    });

    return this.getChart(level.reference_chart_id);
  }

  async listCharts(
    query: ListReferenceChartsQueryDto,
    actor: AuthenticatedUser,
  ): Promise<PaginatedResult<Record<string, unknown>>> {
    const params: unknown[] = [];
    const filters: string[] = [];

    if (query.testMethodId) {
      params.push(query.testMethodId);
      filters.push(`rc.test_method_id = $${params.length}`);
    }
    if (query.laboratoryId) {
      params.push(query.laboratoryId);
      filters.push(`(rc.laboratory_id IS NULL OR rc.laboratory_id = $${params.length})`);
    } else if (actor.role !== UserRole.SUPER_ADMIN) {
      const labIds = actor.memberships.map((m) => m.laboratoryId);
      if (labIds.length === 0) {
        filters.push('rc.laboratory_id IS NULL');
      } else {
        params.push(labIds);
        filters.push(
          `(rc.laboratory_id IS NULL OR rc.laboratory_id = ANY($${params.length}::uuid[]))`,
        );
      }
    }
    if (query.activeOnly !== false) {
      filters.push('rc.is_active');
    }

    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    const totalRow = await this.db.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM reference_charts rc ${where}`,
      params,
    );

    params.push(query.take, query.offset);
    const rows = await this.db.query<{ id: string }>(
      `SELECT rc.id FROM reference_charts rc ${where}
        ORDER BY rc.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const charts = await Promise.all(rows.map((row) => this.getChart(row.id)));

    return {
      data: charts,
      meta: buildPaginationMeta(
        query.page ?? 1,
        query.take,
        Number(totalRow?.count ?? 0),
      ),
    };
  }

  async getChart(id: string): Promise<Record<string, unknown>> {
    const chart = await this.db.queryOne(
      `SELECT rc.*, tm.code AS method_code, tm.name AS method_name,
              tm.target_analyte, tm.concentration_unit
         FROM reference_charts rc
         JOIN test_methods tm ON tm.id = rc.test_method_id
        WHERE rc.id = $1`,
      [id],
    );
    if (!chart) throw ApiError.notFound('Reference chart');

    const levels = await this.db.query(
      `SELECT id, label, concentration_value, concentration_unit, sort_order,
              rgb_r, rgb_g, rgb_b, lab_l, lab_a, lab_b, lab_std,
              roi_x, roi_y, roi_width, roi_height,
              color_source, validation_status::text AS validation_status, notes
         FROM reference_levels
        WHERE reference_chart_id = $1
        ORDER BY sort_order`,
      [id],
    );

    const mappedLevels = levels.map((level) => ({
      id: level.id,
      label: level.label,
      concentrationValue:
        level.concentration_value !== null ? Number(level.concentration_value) : null,
      concentrationUnit: level.concentration_unit,
      sortOrder: level.sort_order,
      rgb:
        level.rgb_r !== null
          ? [Number(level.rgb_r), Number(level.rgb_g), Number(level.rgb_b)]
          : null,
      lab:
        level.lab_l !== null
          ? [Number(level.lab_l), Number(level.lab_a), Number(level.lab_b)]
          : null,
      labStd: level.lab_std !== null ? Number(level.lab_std) : null,
      roi:
        level.roi_x !== null
          ? {
              x: Number(level.roi_x),
              y: Number(level.roi_y),
              width: Number(level.roi_width),
              height: Number(level.roi_height),
            }
          : null,
      colorSource: level.color_source,
      validationStatus: level.validation_status,
      notes: level.notes,
      // Surfaced per level so the UI can mark the ones that cannot take part.
      usableForMatching: level.lab_l !== null,
    }));

    return {
      id: chart.id,
      testMethodId: chart.test_method_id,
      testMethodCode: chart.method_code,
      testMethodName: chart.method_name,
      targetAnalyte: chart.target_analyte,
      laboratoryId: chart.laboratory_id,
      name: chart.name,
      description: chart.description,
      source: chart.source,
      sourceUrl: chart.source_url,
      illuminant: chart.illuminant,
      captureDevice: chart.capture_device,
      version: chart.version,
      validationStatus: chart.validation_status,
      validatedBy: chart.validated_by,
      validatedAt: (chart.validated_at as Date | null)?.toISOString() ?? null,
      chartImageId: chart.chart_image_id,
      supersedesId: chart.supersedes_id,
      isActive: chart.is_active,
      levels: mappedLevels,
      levelCount: mappedLevels.length,
      usableLevelCount: mappedLevels.filter((l) => l.usableForMatching).length,
      // The headline caveat, computed rather than stored so it cannot go stale.
      isIllustrativeOnly: chart.validation_status === 'ILLUSTRATIVE',
      createdAt: (chart.created_at as Date).toISOString(),
      updatedAt: (chart.updated_at as Date).toISOString(),
    };
  }

  async updateChart(
    id: string,
    dto: UpdateReferenceChartDto,
    actor: AuthenticatedUser,
    effectiveRole: UserRole,
    correlationId?: string,
  ): Promise<Record<string, unknown>> {
    const existing = await this.db.queryOne<{
      id: string;
      laboratory_id: string | null;
    }>('SELECT id, laboratory_id FROM reference_charts WHERE id = $1', [id]);
    if (!existing) throw ApiError.notFound('Reference chart');

    const params: unknown[] = [id];
    const updates: string[] = [];

    const assignable: Record<string, unknown> = {
      name: dto.name,
      description: dto.description,
      source: dto.source,
      illuminant: dto.illuminant,
      is_active: dto.isActive,
    };

    for (const [column, value] of Object.entries(assignable)) {
      if (value !== undefined) {
        params.push(value);
        updates.push(`${column} = $${params.length}`);
      }
    }

    if (dto.validationStatus !== undefined) {
      this.assertMayChangeValidation(dto.validationStatus, effectiveRole);
      params.push(dto.validationStatus);
      updates.push(`validation_status = $${params.length}::validation_status`);
      if (dto.validationStatus === ValidationStatus.VALIDATED) {
        params.push(actor.id);
        updates.push(`validated_by = $${params.length}`, 'validated_at = now()');
      }
    }

    if (updates.length === 0) return this.getChart(id);

    await this.db.query(
      `UPDATE reference_charts SET ${updates.join(', ')} WHERE id = $1`,
      params,
    );

    await this.auditService.record({
      actorUserId: actor.id,
      actorEmail: actor.email,
      laboratoryId: existing.laboratory_id,
      action: AuditAction.CHART_UPDATE,
      resourceType: 'reference_chart',
      resourceId: id,
      correlationId,
      metadata: { validationStatus: dto.validationStatus },
    });

    return this.getChart(id);
  }

  /** Resolves the owning laboratory of a chart, for access checks. */
  async resolveChartLaboratory(chartId: string): Promise<string | null> {
    const row = await this.db.queryOne<{ laboratory_id: string | null }>(
      'SELECT laboratory_id FROM reference_charts WHERE id = $1',
      [chartId],
    );
    if (!row) throw ApiError.notFound('Reference chart');
    return row.laboratory_id;
  }

  async resolveLevelLaboratory(levelId: string): Promise<string | null> {
    const row = await this.db.queryOne<{ laboratory_id: string | null }>(
      `SELECT rc.laboratory_id
         FROM reference_levels rl
         JOIN reference_charts rc ON rc.id = rl.reference_chart_id
        WHERE rl.id = $1`,
      [levelId],
    );
    if (!row) throw ApiError.notFound('Reference level');
    return row.laboratory_id;
  }

  async resolveMethodLaboratory(methodId: string): Promise<string | null> {
    const row = await this.db.queryOne<{ laboratory_id: string | null }>(
      'SELECT laboratory_id FROM test_methods WHERE id = $1',
      [methodId],
    );
    if (!row) throw ApiError.notFound('Test method');
    return row.laboratory_id;
  }

  /**
   * Promoting reference data to REVIEWED or VALIDATED is a scientific
   * judgement with downstream consequences — the analysis pipeline reads this
   * status when deciding whether it may report a concentration at all. It is
   * gated on an explicit capability rather than on ordinary write access.
   */
  private assertMayChangeValidation(
    target: ValidationStatus,
    effectiveRole: UserRole,
  ): void {
    const elevated =
      target === ValidationStatus.VALIDATED || target === ValidationStatus.REVIEWED;

    if (elevated && !roleHasPermission(effectiveRole, Permission.REFERENCE_VALIDATE)) {
      throw ApiError.forbidden(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Marking reference data as ${target} requires the ` +
          `${Permission.REFERENCE_VALIDATE} capability.`,
      );
    }
  }

  private mapTestMethod(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      laboratoryId: row.laboratory_id,
      code: row.code,
      name: row.name,
      targetAnalyte: row.target_analyte,
      description: row.description,
      procedureReference: row.procedure_reference,
      applicableMatrix: row.applicable_matrix,
      reagentNotes: row.reagent_notes,
      methodVersion: row.method_version,
      concentrationUnit: row.concentration_unit,
      limitOfDetection:
        row.limit_of_detection !== null ? Number(row.limit_of_detection) : null,
      limitOfQuantitation:
        row.limit_of_quantitation !== null ? Number(row.limit_of_quantitation) : null,
      validationStatus: row.validation_status,
      validatedBy: row.validated_by,
      validatedAt: (row.validated_at as Date | null)?.toISOString() ?? null,
      validationNotes: row.validation_notes,
      isActive: row.is_active,
      chartCount: Number(row.chart_count ?? 0),
      // Computed, so the warning can never drift from the stored status.
      isValidated: row.validation_status === 'VALIDATED',
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
    };
  }
}
