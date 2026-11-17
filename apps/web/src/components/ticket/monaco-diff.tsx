'use client';

import { DiffEditor } from '@monaco-editor/react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { ensureMonaco } from '@/lib/monaco';

export interface MonacoDiffProps {
  original: string;
  modified: string;
  /** Repository path; its extension selects the language. */
  path: string;
  sideBySide: boolean;
  /** Monaco could not be loaded; the caller falls back to the stored patch. */
  onUnavailable: () => void;
}

/** Read-only side-by-side (or inline) diff of one file. Loaded only in the browser. */
export default function MonacoDiff({ original, modified, path, sideBySide, onUnavailable }: MonacoDiffProps) {
  const [ready, setReady] = useState(false);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    let active = true;
    ensureMonaco().then(
      () => {
        if (active) setReady(true);
      },
      () => {
        if (active) onUnavailable();
      },
    );
    return () => {
      active = false;
    };
  }, [onUnavailable]);

  if (!ready) return <Skeleton className="h-[32rem] w-full" />;
  return (
    <DiffEditor
      height="32rem"
      original={original}
      modified={modified}
      originalModelPath={`inmemory://original/${path}`}
      modifiedModelPath={`inmemory://modified/${path}`}
      theme={resolvedTheme === 'dark' ? 'vs-dark' : 'light'}
      options={{
        readOnly: true,
        originalEditable: false,
        renderSideBySide: sideBySide,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderOverviewRuler: false,
      }}
    />
  );
}
