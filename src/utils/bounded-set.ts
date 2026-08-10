export function rememberBounded<T>(
  values: Set<T>,
  value: T,
  maximumSize: number
): boolean {
  if (values.has(value)) return false;
  if (maximumSize <= 0) return true;
  while (values.size >= maximumSize) {
    const oldest = values.values().next().value as T | undefined;
    if (oldest === undefined) break;
    values.delete(oldest);
  }
  values.add(value);
  return true;
}
