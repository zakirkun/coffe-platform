import type { Metadata } from 'next';
import { RunnersPage } from '@/components/runners/runners-page';

export const metadata: Metadata = { title: 'Runners' };

export default function Page() {
  return <RunnersPage />;
}
