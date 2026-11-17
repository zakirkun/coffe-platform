import {
  BindRepoRequest,
  CreateProjectRequest,
  type Project,
  type ProjectRepoBinding,
  UpdateProjectRequest,
  Uuid,
} from '@coffe/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Audit } from '../audit/audit.interceptor.js';
import { CurrentUser, CurrentWorkspace, RequirePermission } from '../auth/decorators.js';
import type { AuthUser, WorkspaceContext } from '../auth/request-context.js';
import { WorkspaceGuard } from '../auth/workspace.guard.js';
import { ProjectsService } from './projects.service.js';

@Controller('workspaces/:ws/projects')
@UseGuards(WorkspaceGuard)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list(@CurrentWorkspace() workspace: WorkspaceContext): Promise<Project[]> {
    return this.projects.list(workspace.id);
  }

  @Post()
  @RequirePermission({ project: ['create'] })
  @Audit('project.created', 'project')
  create(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentUser() user: AuthUser,
    @Body({ schema: CreateProjectRequest }) body: CreateProjectRequest,
  ): Promise<Project> {
    return this.projects.create(workspace.id, user.id, body);
  }

  @Get(':projectId')
  get(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('projectId', { schema: Uuid }) projectId: string,
  ): Promise<Project> {
    return this.projects.get(workspace.id, projectId);
  }

  @Patch(':projectId')
  @RequirePermission({ project: ['update'] })
  @Audit('project.updated', 'project', 'projectId')
  update(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('projectId', { schema: Uuid }) projectId: string,
    @Body({ schema: UpdateProjectRequest }) body: UpdateProjectRequest,
  ): Promise<Project> {
    return this.projects.update(workspace.id, projectId, body);
  }

  @Get(':projectId/repos')
  listRepos(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('projectId', { schema: Uuid }) projectId: string,
  ): Promise<ProjectRepoBinding[]> {
    return this.projects.listRepos(workspace.id, projectId);
  }

  @Post(':projectId/repos')
  @RequirePermission({ project: ['update'] })
  @Audit('project.repo_bound', 'project', 'projectId')
  bindRepo(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('projectId', { schema: Uuid }) projectId: string,
    @Body({ schema: BindRepoRequest }) body: BindRepoRequest,
  ): Promise<ProjectRepoBinding> {
    return this.projects.bindRepo(workspace.id, projectId, body);
  }

  @Delete(':projectId/repos/:bindingId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission({ project: ['update'] })
  @Audit('project.repo_unbound', 'project', 'projectId')
  unbindRepo(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('projectId', { schema: Uuid }) projectId: string,
    @Param('bindingId', { schema: Uuid }) bindingId: string,
  ): Promise<void> {
    return this.projects.unbindRepo(workspace.id, projectId, bindingId);
  }
}
