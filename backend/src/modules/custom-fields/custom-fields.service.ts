import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import type { CustomFieldType } from '../../shared/models';
import { NotFoundError, ValidationError } from '../../common/errors/domain-error';
import { DRIZZLE, type Db } from '../../core/database/drizzle.service';
import * as s from '../../core/database/schema';
import { insertedId, UnitOfWork } from '../../core/database/unit-of-work';

export interface CustomFieldInput {
  name: string;
  type: CustomFieldType;
  options?: string[];
  required?: boolean;
  defaultValue?: string;
  /** The projects that expose this field, reconciled in the same transaction. */
  projectIds?: number[];
}

@Injectable()
export class CustomFieldsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly uow: UnitOfWork,
  ) {}

  async create(input: CustomFieldInput): Promise<{ id: number }> {
    this.assertOptions(input);
    const id = await this.uow.transaction(async (tx) => {
      const fieldId = insertedId(
        await tx.insert(s.customFields).values({
          name: input.name.trim(),
          type: input.type,
          // Only meaningful for 'list'; stored newline-joined so the order survives.
          options: input.type === 'list' ? (input.options ?? []).join('\n') : '',
          required: input.required ?? false,
          defaultValue: input.defaultValue ?? '',
        }),
      );
      await this.linkProjects(tx, fieldId, input.projectIds ?? []);
      return fieldId;
    });
    return { id };
  }

  async update(id: number, input: Partial<CustomFieldInput>): Promise<void> {
    const [existing] = await this.db.select().from(s.customFields).where(eq(s.customFields.id, id)).limit(1);
    if (!existing) throw new NotFoundError('customField', id);
    const type = input.type ?? existing.type;
    this.assertOptions({ ...input, type, name: input.name ?? existing.name });

    await this.uow.transaction(async (tx) => {
      await tx
        .update(s.customFields)
        .set({
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.options !== undefined
            ? { options: type === 'list' ? input.options.join('\n') : '' }
            : {}),
          ...(input.required !== undefined ? { required: input.required } : {}),
          ...(input.defaultValue !== undefined ? { defaultValue: input.defaultValue } : {}),
        })
        .where(eq(s.customFields.id, id));

      if (input.projectIds) await this.linkProjects(tx, id, input.projectIds);
    });
  }

  /**
   * Deletes a field and every value of it.
   *
   * Hard delete, because a custom field has no audit value of its own: the issues' values go
   * with it, and there is no history to preserve — the frontend writes none for custom field
   * changes either. The usage count is returned so the caller can warn first.
   */
  async remove(id: number): Promise<{ removedValues: number }> {
    const [existing] = await this.db.select().from(s.customFields).where(eq(s.customFields.id, id)).limit(1);
    if (!existing) throw new NotFoundError('customField', id);

    return this.uow.transaction(async (tx) => {
      const [counted] = await tx
        .select({ n: sql<number>`COUNT(*)` })
        .from(s.issueCustomValues)
        .where(eq(s.issueCustomValues.customFieldId, id));

      await tx.delete(s.issueCustomValues).where(eq(s.issueCustomValues.customFieldId, id));
      await tx.delete(s.projectCustomFields).where(eq(s.projectCustomFields.customFieldId, id));
      await tx.delete(s.customFields).where(eq(s.customFields.id, id));
      return { removedValues: Number(counted?.n ?? 0) };
    });
  }

  private async linkProjects(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    customFieldId: number,
    projectIds: number[],
  ): Promise<void> {
    await tx.delete(s.projectCustomFields).where(eq(s.projectCustomFields.customFieldId, customFieldId));
    if (!projectIds.length) return;

    const known = await tx
      .select({ id: s.projects.id })
      .from(s.projects)
      .where(inArray(s.projects.id, projectIds));
    if (known.length !== new Set(projectIds).size) {
      throw new ValidationError('errors.validation', 'Unknown project in projectIds');
    }
    await tx.insert(s.projectCustomFields).values(
      projectIds.map((projectId, sortOrder) => ({ projectId, customFieldId, sortOrder })),
    );
  }

  private assertOptions(input: Partial<CustomFieldInput> & { type: CustomFieldType }): void {
    if (input.type === 'list' && !(input.options ?? []).filter((o) => o.trim()).length) {
      throw new ValidationError('errors.validation', "A field of type 'list' needs at least one option");
    }
  }
}
