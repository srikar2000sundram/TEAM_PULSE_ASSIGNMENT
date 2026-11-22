/**
 * What an aggregate is about: one team, or the whole organisation. Every activity is counted in
 * the organisation and in each team the person belonged to when it happened.
 */
export type AggregateScope =
  { readonly kind: 'organization' } | { readonly kind: 'team'; readonly teamId: string };

/** The storage key of a scope. Stable: changing it would orphan stored data. */
export function scopeKey(scope: AggregateScope): string {
  return scope.kind === 'organization' ? 'SCOPE#ORG' : `SCOPE#TEAM#${scope.teamId}`;
}

export const ORGANIZATION: AggregateScope = { kind: 'organization' };

/** The scopes one activity counts in. Duplicate team ids are counted once. */
export function scopesOfActivity(teamIds: readonly string[]): AggregateScope[] {
  return [
    ORGANIZATION,
    ...[...new Set(teamIds)].map((teamId): AggregateScope => ({ kind: 'team', teamId })),
  ];
}
