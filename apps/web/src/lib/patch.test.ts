import { describe, expect, it } from 'vitest';
import { classifyPatchLines, splitPatchByFile } from './patch';

const PATCH = [
  'diff --git a/src/cart.ts b/src/cart.ts',
  'index 1111111..2222222 100644',
  '--- a/src/cart.ts',
  '+++ b/src/cart.ts',
  '@@ -1,2 +1,2 @@',
  ' export const items = [];',
  '-export const badge = false;',
  '+export const badge = true;',
  'diff --git a/old name.md b/docs/new name.md',
  'similarity index 90%',
  'rename from old name.md',
  'rename to docs/new name.md',
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  '\\ No newline at end of file',
  'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
  'new file mode 100644',
  '--- /dev/null',
  '+++ "b/caf\\303\\251.txt"',
  '@@ -0,0 +1 @@',
  '+bonjour',
  '',
].join('\n');

describe('splitPatchByFile', () => {
  it('keys each section by the path DiffFile uses', () => {
    const sections = splitPatchByFile(PATCH);
    expect([...sections.keys()]).toEqual(['src/cart.ts', 'docs/new name.md', 'gone.txt', 'café.txt']);
    expect(sections.get('src/cart.ts')?.split('\n').at(-1)).toBe('+export const badge = true;');
    expect(sections.get('café.txt')?.endsWith('+bonjour')).toBe(true);
  });
});

describe('classifyPatchLines', () => {
  it('separates the header from hunks, additions, deletions and markers', () => {
    const section = splitPatchByFile(PATCH).get('gone.txt') ?? '';
    expect(classifyPatchLines(section).map((line) => line.kind)).toEqual([
      'meta',
      'meta',
      'meta',
      'meta',
      'hunk',
      'del',
      'meta',
    ]);
  });
});
