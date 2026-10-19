/** Bounded email shape check for a new setup submission; existing accounts are untouched. */
export function validSetupEmail(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 254 || /\s/.test(value)) return false;
  const at = value.indexOf('@');
  if (at < 1 || value.indexOf('@', at + 1) !== -1) return false;
  const dot = value.lastIndexOf('.');
  return dot > at + 1 && dot < value.length - 1;
}

export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}
