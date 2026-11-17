import type {
  ContextDoc,
  ContextPreview,
  CreateContextDocRequest,
  UpdateContextDocRequest,
} from '@coffe/contracts';
import type { ContextBundle, RunKind } from '@coffe/protocol';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, max } from 'drizzle-orm';
import { ApiException } from '../common/api-error.js';
import type { Database } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { contextDocs, personas, projects, requirements, tickets } from '../db/schema/index.js';
import { buildContextFiles } from './context-bundle.js';

type ContextDocRow = typeof contextDocs.$inferSelect;

function toContextDoc(row: ContextDocRow): ContextDoc {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    title: row.title,
    body: row.body,
    enabled: row.enabled,
    position: row.position,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface BundleRequest {
  projectId: string;
  kind: RunKind;
  ticketId?: string | null;
  personaId?: string | null;
  requirementId?: string | null;
  handoff?: string | null;
}

/** Project knowledge base and rules (architecture §11.4), and the bundle every run receives. */
@Injectable()
export class ContextService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(workspaceId: string, projectId: string): Promise<ContextDoc[]> {
    await this.assertProject(workspaceId, projectId);
    const rows = await this.db
      .select()
      .from(contextDocs)
      .where(eq(contextDocs.projectId, projectId))
      .orderBy(asc(contextDocs.kind), asc(contextDocs.position), asc(contextDocs.createdAt));
    return rows.map(toContextDoc);
  }

  async create(workspaceId: string, userId: string, projectId: string, body: CreateContextDocRequest): Promise<ContextDoc> {
    await this.assertProject(workspaceId, projectId);
    const [last] = await this.db
      .select({ position: max(contextDocs.position) })
      .from(contextDocs)
      .where(and(eq(contextDocs.projectId, projectId), eq(contextDocs.kind, body.kind)));
    const [row] = await this.db
      .insert(contextDocs)
      .values({
        projectId,
        kind: body.kind,
        title: body.title.trim(),
        body: body.body,
        enabled: body.enabled,
        position: (last?.position ?? -1) + 1,
        updatedBy: userId,
      })
      .returning();
    if (!row) throw new Error('context doc insert returned no row');
    return toContextDoc(row);
  }

  async update(workspaceId: string, userId: string, docId: string, body: UpdateContextDocRequest): Promise<ContextDoc> {
    await this.getRow(workspaceId, docId);
    const [row] = await this.db
      .update(contextDocs)
      .set({
        ...(body.title !== undefined ? { title: body.title.trim() } : {}),
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.position !== undefined ? { position: body.position } : {}),
        updatedBy: userId,
        updatedAt: new Date(),
      })
      .where(eq(contextDocs.id, docId))
      .returning();
    if (!row) throw ApiException.notFound('Context document');
    return toContextDoc(row);
  }

  async remove(workspaceId: string, docId: string): Promise<void> {
    await this.getRow(workspaceId, docId);
    await this.db.delete(contextDocs).where(eq(contextDocs.id, docId));
  }

  /** The exact files a run would receive (transparency in the UI). */
  async preview(workspaceId: string, projectId: string, ticketId?: string, personaId?: string): Promise<ContextPreview> {
    await this.assertProject(workspaceId, projectId);
    const bundle = await this.build({ projectId, kind: 'ticket', ticketId, personaId });
    return {
      files: bundle.files,
      totalBytes: bundle.files.reduce((total, file) => total + Buffer.byteLength(file.content), 0),
    };
  }

  /** Builds the context bundle of a run from the current project state. */
  async build(request: BundleRequest): Promise<ContextBundle> {
    const docs = await this.db
      .select({ kind: contextDocs.kind, title: contextDocs.title, body: contextDocs.body })
      .from(contextDocs)
      .where(and(eq(contextDocs.projectId, request.projectId), eq(contextDocs.enabled, true)))
      .orderBy(asc(contextDocs.position), asc(contextDocs.createdAt));
    const [ticket] = request.ticketId
      ? await this.db.select().from(tickets).where(eq(tickets.id, request.ticketId)).limit(1)
      : [];
    const [persona] = request.personaId
      ? await this.db.select().from(personas).where(eq(personas.id, request.personaId)).limit(1)
      : [];
    const [requirement] = request.requirementId
      ? await this.db.select().from(requirements).where(eq(requirements.id, request.requirementId)).limit(1)
      : [];
    const files = buildContextFiles({
      kind: request.kind,
      ticket: ticket
        ? { key: ticket.key, title: ticket.title, description: ticket.description, acceptanceCriteria: ticket.acceptanceCriteria }
        : null,
      requirement: requirement ? { title: requirement.title, body: requirement.body } : null,
      persona: persona ? { name: persona.name, role: persona.role, instructions: persona.instructions } : null,
      rules: docs.filter((doc) => doc.kind === 'rule'),
      knowledge: docs.filter((doc) => doc.kind === 'knowledge'),
      handoff: request.handoff ?? null,
    });
    return { files, attachments: [] };
  }

  private async getRow(workspaceId: string, docId: string): Promise<ContextDocRow> {
    const [row] = await this.db
      .select({ doc: contextDocs, workspaceId: projects.workspaceId })
      .from(contextDocs)
      .innerJoin(projects, eq(projects.id, contextDocs.projectId))
      .where(eq(contextDocs.id, docId))
      .limit(1);
    if (!row || row.workspaceId !== workspaceId) throw ApiException.notFound('Context document');
    return row.doc;
  }

  private async assertProject(workspaceId: string, projectId: string): Promise<void> {
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
      .limit(1);
    if (!project) throw ApiException.notFound('Project');
  }
}
