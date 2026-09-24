/**
 * Resolves the name to present for an account: the user-set `alias` when
 * non-empty, otherwise the broker/tooling `name`, otherwise the `externalId`.
 */
export function resolveAccountName(account: {
  alias?: string | null;
  name?: string | null;
  externalId: string;
}): string {
  const alias = account.alias?.trim();
  if (alias) return alias;
  const name = account.name?.trim();
  return name ? name : account.externalId;
}
