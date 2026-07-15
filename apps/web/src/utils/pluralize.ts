/**
 * `1 step` / `2 steps` — count + English noun with a trailing `s` when plural.
 * For irregular nouns pass the plural form explicitly.
 */
export function pluralize(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}
