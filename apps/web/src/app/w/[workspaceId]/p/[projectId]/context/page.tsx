import type { Metadata } from 'next';
import { ContextPage } from '@/components/context/context-page';

export const metadata: Metadata = { title: 'Project context' };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ContextPage projectId={projectId} />;
}
