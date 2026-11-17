'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { FullPageSpinner } from '@/components/full-page-spinner';
import { ApiRequestError } from '@/lib/api';
import { useMe } from '@/lib/queries/session';

/** Sends signed-out visitors to sign-in and everyone else to their active workspace. */
export default function HomePage() {
  const router = useRouter();
  const me = useMe();
  const signedOut = me.error instanceof ApiRequestError && me.error.status === 401;

  useEffect(() => {
    if (signedOut) {
      router.replace('/sign-in');
      return;
    }
    if (!me.data) return;
    const workspaceId = me.data.activeWorkspaceId ?? me.data.workspaces[0]?.id;
    router.replace(workspaceId ? `/w/${workspaceId}` : '/onboarding');
  }, [me.data, signedOut, router]);

  return <FullPageSpinner error={signedOut ? null : me.error} />;
}
