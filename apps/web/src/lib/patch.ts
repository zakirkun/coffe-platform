/**
 * Minimal reader for the stored unified patch (`git diff` output). It backs the review fallback
 * when the runner is offline and file contents cannot be fetched for the side-by-side editor.
 */

export type PatchLineKind = 'meta' | 'hunk' | 'add' | 'del' | 'context';

export interface PatchLine {
  kind: PatchLineKind;
  text: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const SIMPLE_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};

/** Reverses git's C-style path quoting (`"caf\303\251.txt"` → `café.txt`). */
function unquoteGitPath(quoted: string): string {
  const bytes: number[] = [];
  const body = quoted.slice(1, quoted.endsWith('"') ? -1 : undefined);
  let index = 0;
  while (index < body.length) {
    if (body.charAt(index) !== '\\') {
      const char = String.fromCodePoint(body.codePointAt(index) ?? 0);
      bytes.push(...textEncoder.encode(char));
      index += char.length;
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(body.slice(index + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 1 + octal[0].length;
      continue;
    }
    const escaped = body.charAt(index + 1);
    bytes.push(SIMPLE_ESCAPES[escaped] ?? escaped.charCodeAt(0));
    index += 2;
  }
  return textDecoder.decode(new Uint8Array(bytes));
}

/** Path from a `--- a/x` / `+++ b/x` / `rename to x` value; `null` for `/dev/null`. */
function readPath(raw: string, prefixed: boolean): string | null {
  const [value = ''] = raw.split('\t');
  const path = value.startsWith('"') ? unquoteGitPath(value) : value;
  if (path === '/dev/null') return null;
  return prefixed ? path.replace(/^[ab]\//, '') : path;
}

/** Best effort for `diff --git a/x b/x` headers without `---`/`+++` lines (binary, mode-only). */
function pathFromDiffHeader(header: string): string | null {
  const rest = header.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    const match = /"((?:[^"\\]|\\.)*)"$/.exec(rest);
    return match ? readPath(`"${match[1]}"`, true) : null;
  }
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest.slice(2, half) === rest.slice(half + 3)) {
    return rest.slice(2, half);
  }
  const separator = rest.lastIndexOf(' b/');
  return separator === -1 ? null : rest.slice(separator + 3);
}

/**
 * Splits a multi-file patch into per-file sections keyed by the file's current path (the old
 * path for deletions), matching `DiffFile.path`.
 */
export function splitPatchByFile(patch: string): Map<string, string> {
  const sections = new Map<string, string>();
  let lines: string[] = [];
  let headerPath: string | null = null;
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let renameTo: string | null = null;
  let inHeader = false;

  const flush = () => {
    // The patch ends with a newline; do not turn it into an empty trailing row.
    if (lines.at(-1) === '') lines.pop();
    const key = newPath ?? renameTo ?? oldPath ?? headerPath;
    if (key !== null && lines.length > 0) sections.set(key, lines.join('\n'));
  };

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      lines = [line];
      headerPath = pathFromDiffHeader(line);
      oldPath = null;
      newPath = null;
      renameTo = null;
      inHeader = true;
      continue;
    }
    if (lines.length === 0) continue;
    if (inHeader) {
      if (line.startsWith('@@')) inHeader = false;
      else if (line.startsWith('--- ')) oldPath = readPath(line.slice(4), true);
      else if (line.startsWith('+++ ')) newPath = readPath(line.slice(4), true);
      else if (line.startsWith('rename to ')) renameTo = readPath(line.slice(10), false);
    }
    lines.push(line);
  }
  flush();
  return sections;
}

/** Classifies the lines of one file section for colouring. */
export function classifyPatchLines(section: string): PatchLine[] {
  let inHeader = true;
  return section.split('\n').map((text): PatchLine => {
    if (text.startsWith('@@')) {
      inHeader = false;
      return { kind: 'hunk', text };
    }
    if (inHeader || text.startsWith('\\')) return { kind: 'meta', text };
    if (text.startsWith('+')) return { kind: 'add', text };
    if (text.startsWith('-')) return { kind: 'del', text };
    return { kind: 'context', text };
  });
}
