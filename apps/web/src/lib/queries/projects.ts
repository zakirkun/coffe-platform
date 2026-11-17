import type {
  BindRepoRequest,
  CreateProjectRequest,
  Project,
  UpdateProjectRequest,
} from '@coffe/contracts';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from './keys';
import { upsertById } from './realtime-sync';

export function useProjects(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.projects(workspaceId),
    queryFn: ({ signal }) => api.listProjects(workspaceId, signal),
  });
}

/** `projectId` may be unknown while the entity that references it is still loading. */
export function useProject(workspaceId: string, projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.project(workspaceId, projectId ?? ''),
    queryFn: projectId ? ({ signal }) => api.getProject(workspaceId, projectId, signal) : skipToken,
  });
}

export function useCreateProject(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectRequest) => api.createProject(workspaceId, body),
    onSuccess: (project) => {
      queryClient.setQueryData<Project>(queryKeys.project(workspaceId, project.id), project);
      queryClient.setQueryData<Project[]>(queryKeys.projects(workspaceId), (projects) =>
        upsertById(projects, project),
      );
    },
  });
}

export function useUpdateProject(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateProjectRequest) => api.updateProject(workspaceId, projectId, body),
    onSuccess: (project) => {
      queryClient.setQueryData<Project>(queryKeys.project(workspaceId, project.id), project);
      queryClient.setQueryData<Project[]>(queryKeys.projects(workspaceId), (projects) =>
        upsertById(projects, project),
      );
    },
  });
}

export function useProjectRepos(workspaceId: string, projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.projectRepos(workspaceId, projectId ?? ''),
    queryFn: projectId
      ? ({ signal }) => api.listProjectRepos(workspaceId, projectId, signal)
      : skipToken,
  });
}

export function useBindRepo(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: BindRepoRequest) => api.bindRepo(workspaceId, projectId, body),
    // Binding a primary repository demotes the previous one, so reload the whole list.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.projectRepos(workspaceId, projectId) }),
  });
}

export function useUnbindRepo(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (bindingId: string) => api.unbindRepo(workspaceId, projectId, bindingId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.projectRepos(workspaceId, projectId) }),
  });
}
