interface Semver {
  core: [number, number, number];
  prerelease: string[];
}

function parseSemver(version: string): Semver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    version.trim(),
  );
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/** Semver 2.0 precedence of two prerelease identifier lists (an empty list is a release). */
function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return (a.length === 0 ? 1 : 0) - (b.length === 0 ? 1 : 0);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const left = a[i] ?? '';
    const right = b[i] ?? '';
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return Number(left) < Number(right) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return Math.sign(a.length - b.length);
}

/**
 * Negative / zero / positive like `Array.prototype.sort` comparators; `null` when either version
 * is not valid semver. Build metadata is ignored.
 */
export function compareSemver(a: string, b: string): number | null {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    const difference = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** False for versions below `minimum` and for anything that is not valid semver. */
export function isVersionAtLeast(version: string, minimum: string): boolean {
  const order = compareSemver(version, minimum);
  return order !== null && order >= 0;
}
