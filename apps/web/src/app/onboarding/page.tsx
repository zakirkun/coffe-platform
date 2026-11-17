import type { Metadata } from 'next';
import { CreateWorkspaceForm } from '@/components/workspace/create-workspace-form';

export const metadata: Metadata = { title: 'Create a workspace' };

export default function OnboardingPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-6">
      <div className="w-full max-w-md">
        <CreateWorkspaceForm />
      </div>
    </main>
  );
}
