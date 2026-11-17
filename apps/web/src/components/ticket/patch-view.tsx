import { classifyPatchLines, type PatchLineKind } from '@/lib/patch';
import { cn } from '@/lib/utils';

const LINE_STYLES: Record<PatchLineKind, string> = {
  meta: 'text-muted-foreground',
  hunk: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  add: 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
  del: 'bg-red-500/10 text-red-800 dark:text-red-300',
  context: '',
};

/** One file section of the stored unified patch, coloured by line kind. */
export function PatchView({ section }: { section: string }) {
  return (
    <pre aria-label="Unified diff" className="max-h-[32rem] overflow-auto rounded-md border bg-muted/30 py-2 font-mono text-xs leading-5">
      {classifyPatchLines(section).map((line, index) => (
        // Patch lines have no identity besides their position.
        // biome-ignore lint/suspicious/noArrayIndexKey: static, never reordered
        <div key={index} className={cn('px-3 whitespace-pre', LINE_STYLES[line.kind])}>
          {line.text || ' '}
        </div>
      ))}
    </pre>
  );
}
