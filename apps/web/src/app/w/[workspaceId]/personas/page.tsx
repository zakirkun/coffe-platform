import type { Metadata } from 'next';
import { PersonasPage } from '@/components/personas/personas-page';

export const metadata: Metadata = { title: 'Personas' };

export default function Page() {
  return <PersonasPage />;
}
