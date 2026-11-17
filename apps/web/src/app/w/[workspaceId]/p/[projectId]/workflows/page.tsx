import type { Metadata } from 'next';
import { WorkflowsPage } from '@/components/workflows/workflows-page';

export const metadata: Metadata = { title: 'Workflows' };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <WorkflowsPage projectId={projectId} />;
}
