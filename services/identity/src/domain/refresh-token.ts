export interface RefreshTokenProps {
  readonly id: string;
  readonly userId: string;
  /** All tokens descended from one login share a family, so a stolen chain can be cut at once. */
  readonly familyId: string;
  /** SHA-256 of the secret. The secret itself is never stored. */
  readonly tokenHash: string;
  readonly familyStartedAt: Date;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  /** Set when this token was exchanged for a new one (normal rotation). */
  readonly replacedById: string | null;
}

export interface RotationPolicy {
  /** Lifetime of each individual refresh token. */
  readonly tokenTtlMs: number;
  /** Absolute limit for a whole family, so a session cannot be extended forever by rotating. */
  readonly familyMaxAgeMs: number;
  /**
   * Two tabs refreshing at the same moment present the same token twice. Within this window the
   * second attempt is a harmless race, not theft.
   */
  readonly reuseGraceMs: number;
}

export const DEFAULT_ROTATION_POLICY: RotationPolicy = {
  tokenTtlMs: 7 * 24 * 3_600_000,
  familyMaxAgeMs: 30 * 24 * 3_600_000,
  reuseGraceMs: 10_000,
};

export class RefreshToken {
  private constructor(private readonly props: RefreshTokenProps) {}

  /** First token of a new family (a login). */
  static startFamily(input: {
    id: string;
    userId: string;
    familyId: string;
    tokenHash: string;
    now: Date;
    policy: RotationPolicy;
  }): RefreshToken {
    return new RefreshToken({
      id: input.id,
      userId: input.userId,
      familyId: input.familyId,
      tokenHash: input.tokenHash,
      familyStartedAt: input.now,
      issuedAt: input.now,
      expiresAt: new Date(input.now.getTime() + input.policy.tokenTtlMs),
      revokedAt: null,
      replacedById: null,
    });
  }

  static restore(props: RefreshTokenProps): RefreshToken {
    return new RefreshToken(props);
  }

  get id(): string {
    return this.props.id;
  }
  get userId(): string {
    return this.props.userId;
  }
  get familyId(): string {
    return this.props.familyId;
  }
  get tokenHash(): string {
    return this.props.tokenHash;
  }
  get familyStartedAt(): Date {
    return this.props.familyStartedAt;
  }
  get issuedAt(): Date {
    return this.props.issuedAt;
  }
  get expiresAt(): Date {
    return this.props.expiresAt;
  }
  get revokedAt(): Date | null {
    return this.props.revokedAt;
  }
  get replacedById(): string | null {
    return this.props.replacedById;
  }

  isExpired(now: Date): boolean {
    return this.props.expiresAt.getTime() <= now.getTime();
  }

  get isRevoked(): boolean {
    return this.props.revokedAt !== null;
  }

  /** True when the family has outlived its absolute maximum age. */
  isFamilyTooOld(now: Date, policy: RotationPolicy): boolean {
    return now.getTime() - this.props.familyStartedAt.getTime() >= policy.familyMaxAgeMs;
  }

  /** True when this token was legitimately rotated away only moments ago (a benign race). */
  wasJustRotated(now: Date, policy: RotationPolicy): boolean {
    return (
      this.props.replacedById !== null &&
      this.props.revokedAt !== null &&
      now.getTime() - this.props.revokedAt.getTime() <= policy.reuseGraceMs
    );
  }

  /** Ends the token without a successor (logout, password change, reuse detection). */
  revoke(now: Date): RefreshToken {
    if (this.props.revokedAt !== null) return this;
    return new RefreshToken({ ...this.props, revokedAt: now });
  }

  /** Marks this token as exchanged. */
  rotateTo(successorId: string, now: Date): RefreshToken {
    return new RefreshToken({ ...this.props, revokedAt: now, replacedById: successorId });
  }

  /** The successor token: same family, lifetime capped by the family's absolute limit. */
  successor(input: {
    id: string;
    tokenHash: string;
    now: Date;
    policy: RotationPolicy;
  }): RefreshToken {
    const familyDeadline = this.props.familyStartedAt.getTime() + input.policy.familyMaxAgeMs;
    const expiresAt = Math.min(input.now.getTime() + input.policy.tokenTtlMs, familyDeadline);
    return new RefreshToken({
      id: input.id,
      userId: this.props.userId,
      familyId: this.props.familyId,
      tokenHash: input.tokenHash,
      familyStartedAt: this.props.familyStartedAt,
      issuedAt: input.now,
      expiresAt: new Date(expiresAt),
      revokedAt: null,
      replacedById: null,
    });
  }
}
