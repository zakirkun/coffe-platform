/**
 * Suggests a ticket key prefix for a project name: initials for multi-word names
 * ("Customer Portal" → `CP`), the first three characters otherwise ("coffe" → `COF`). The result
 * satisfies `ProjectKey` (2–6 uppercase letters/digits starting with a letter) or is empty when
 * the name does not contain enough to build one yet.
 */
export function suggestProjectKey(name: string): string {
  const words = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((word) => word.length > 0);
  const firstLetterWord = words.findIndex((word) => /^[A-Z]/.test(word));
  if (firstLetterWord === -1) return '';
  const usable = words.slice(firstLetterWord);
  const [first = ''] = usable;
  if (usable.length === 1) return first.length >= 2 ? first.slice(0, 3) : '';
  return usable
    .map((word) => word.charAt(0))
    .join('')
    .slice(0, 6);
}
