import {
  CreatePersonaRequest,
  type Persona,
  PersonaQuery,
  UpdatePersonaRequest,
  Uuid,
} from '@coffe/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { z } from 'zod';
import { Audit } from '../audit/audit.interceptor.js';
import { CurrentUser, CurrentWorkspace, RequirePermission } from '../auth/decorators.js';
import type { AuthUser, WorkspaceContext } from '../auth/request-context.js';
import { WorkspaceGuard } from '../auth/workspace.guard.js';
import { PersonasService } from './personas.service.js';

@Controller('workspaces/:ws/personas')
@UseGuards(WorkspaceGuard)
export class PersonasController {
  constructor(private readonly personas: PersonasService) {}

  @Get()
  list(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query({ schema: PersonaQuery }) query: z.output<typeof PersonaQuery>,
  ): Promise<Persona[]> {
    return this.personas.list(workspace.id, query.projectId);
  }

  @Post()
  @RequirePermission({ project: ['update'] })
  @Audit('persona.create', 'persona')
  create(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentUser() user: AuthUser,
    @Body({ schema: CreatePersonaRequest }) body: CreatePersonaRequest,
  ): Promise<Persona> {
    return this.personas.create(workspace.id, user.id, body);
  }

  @Patch(':personaId')
  @RequirePermission({ project: ['update'] })
  @Audit('persona.update', 'persona', 'personaId')
  update(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('personaId', { schema: Uuid }) personaId: string,
    @Body({ schema: UpdatePersonaRequest }) body: UpdatePersonaRequest,
  ): Promise<Persona> {
    return this.personas.update(workspace.id, personaId, body);
  }

  @Delete(':personaId')
  @HttpCode(204)
  @RequirePermission({ project: ['update'] })
  @Audit('persona.archive', 'persona', 'personaId')
  async archive(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('personaId', { schema: Uuid }) personaId: string,
  ): Promise<void> {
    await this.personas.archive(workspace.id, personaId);
  }
}
