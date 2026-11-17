'use client';

import type { WorkspaceRole } from '@coffe/contracts';
import { createContext, useContext } from 'react';

export interface CurrentWorkspace {
  id: string;
  name: string;
  role: WorkspaceRole;
}

export const WorkspaceContext = createContext<CurrentWorkspace | null>(null);

/** The workspace of the current `/w/[workspaceId]` route; only valid below `WorkspaceShell`. */
export function useWorkspace(): CurrentWorkspace {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error('useWorkspace() must be used inside the workspace shell');
  return workspace;
}
