import { ProjectBoard } from '@/components/board/project-board';

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ProjectBoard projectId={projectId} />;
}
