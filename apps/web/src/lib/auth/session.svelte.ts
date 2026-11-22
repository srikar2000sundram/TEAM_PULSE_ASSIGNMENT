import type { Role, SessionResponse } from '@teampulse/contracts';
import { ApiError, type TokenSource } from '../api/http.js';
import type { IdentityApi } from '../api/index.js';

export interface SessionUser {
  readonly id: string;
  readonly displayName: string;
  readonly role: Role;
  /** From the access token: used to decide what to show. The APIs enforce access themselves. */
  readonly teamIds: readonly string[];
  readonly managedTeamIds: readonly string[];
}

/** Reads the claims of a JWT without verifying it: the browser only uses them to shape the UI. */
export function readClaims(token: string): { teams: string[]; managedTeams: string[] } {
  try {
    const payload = token.split('.')[1] ?? '';
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json) as { teams?: unknown; managedTeams?: unknown };
    const ids = (value: unknown) =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
    return { teams: ids(claims.teams), managedTeams: ids(claims.managedTeams) };
  } catch {
    return { teams: [], managedTeams: [] };
  }
}

/**
 * Who is signed in. The access token lives in memory only (never in storage), so a page reload asks
 * the Identity Service for a new one with the httpOnly refresh cookie: `restore()`.
 *
 * Implements `TokenSource`, so the HTTP layer can read the token and ask for a refresh.
 */
export class Session implements TokenSource {
  user = $state<SessionUser | null>(null);
  /** False until the first `restore()` finished, so the interface does not flash the login page. */
  ready = $state(false);

  private token: string | null = null;

  constructor(private readonly identity: IdentityApi) {}

  accessToken(): string | null {
    return this.token;
  }

  isManager = $derived(this.user?.role === 'manager');
  isAdmin = $derived(this.user?.role === 'admin');

  private adopt(session: SessionResponse): void {
    this.token = session.accessToken;
    const claims = readClaims(session.accessToken);
    this.user = {
      id: session.user.id,
      displayName: session.user.displayName,
      role: session.user.role,
      teamIds: claims.teams,
      managedTeamIds: claims.managedTeams,
    };
  }

  private clear(): void {
    this.token = null;
    this.user = null;
  }

  async login(email: string, password: string): Promise<void> {
    this.adopt(await this.identity.login(email, password));
  }

  /** Tries to continue a session from the refresh cookie. Never throws. */
  async restore(): Promise<void> {
    try {
      this.adopt(await this.identity.refresh());
    } catch {
      this.clear();
    } finally {
      this.ready = true;
    }
  }

  /** For the HTTP layer: a new access token after a 401. False means the session is over. */
  async refresh(): Promise<boolean> {
    try {
      this.adopt(await this.identity.refresh());
      return true;
    } catch (error) {
      // Only a rejected cookie ends the session; a network blip should not sign people out.
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) this.clear();
      return false;
    }
  }

  async logout(): Promise<void> {
    try {
      await this.identity.logout();
    } finally {
      this.clear();
    }
  }
}
