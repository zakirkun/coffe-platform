import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-muted/40 p-6">
      <div className="flex items-center gap-2 text-lg font-semibold tracking-tight">
        <span aria-hidden className="inline-block size-6 rounded-md bg-primary" />
        COFFE
      </div>
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}
