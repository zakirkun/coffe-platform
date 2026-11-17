import type { Metadata } from 'next';
import { PlanningPage } from '@/components/planning/planning-page';

export const metadata: Metadata = { title: 'Planning' };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <PlanningPage projectId={projectId} />;
}
