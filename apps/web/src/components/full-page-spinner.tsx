import { Loader2 } from 'lucide-react';
import { errorMessage } from '@/lib/api';

/** Centered loading indicator; shows the error instead when loading failed. */
export function FullPageSpinner({ error }: { error?: unknown }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(error)}
        </p>
      ) : (
        <Loader2 aria-label="Loading" className="size-6 animate-spin text-muted-foreground" />
      )}
    </div>
  );
}
