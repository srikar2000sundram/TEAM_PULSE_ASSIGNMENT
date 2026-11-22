import type { SessionResponse } from '@teampulse/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/http.js';
import type { IdentityApi } from '../api/index.js';
import { Session, readClaims } from './session.svelte.js';

const b64url = (value: object) =>
  btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (claims: object) => `header.${b64url(claims)}.signature`;

const ID = '00000000-0000-4000-8000-0000000000a1';
const TEAM = '00000000-0000-4000-8000-000000000071';

const sessionResponse = (
  claims: object,
  role: 'employee' | 'manager' | 'admin' = 'employee',
): SessionResponse => ({
  accessToken: jwt(claims),
  tokenType: 'Bearer',
  expiresIn: 900,
  user: { id: ID, email: 'a@example.com', displayName: 'Ada', role, status: 'active' },
});

function fakeIdentity(overrides: Partial<IdentityApi> = {}): IdentityApi {
  return {
    login: () => Promise.reject(new Error('not set up')),
    refresh: () => Promise.reject(new ApiError(401, 'auth.invalid_token', 'no cookie')),
    logout: () => Promise.resolve(),
    teams: () => Promise.resolve({ items: [] }),
    teamMembers: () => Promise.resolve({ items: [] }),
    ...overrides,
  };
}

describe('readClaims', () => {
  it('reads team claims from the token payload', () => {
    expect(readClaims(jwt({ teams: [TEAM], managedTeams: [TEAM] }))).toEqual({
      teams: [TEAM],
      managedTeams: [TEAM],
    });
  });

  it('copes with base64url characters, missing claims and garbage', () => {
    expect(readClaims(jwt({ teams: ['a>b?c'] })).teams).toEqual(['a>b?c']);
    expect(readClaims(jwt({}))).toEqual({ teams: [], managedTeams: [] });
    expect(readClaims('garbage')).toEqual({ teams: [], managedTeams: [] });
    expect(readClaims(jwt({ teams: 'not-a-list', managedTeams: [1, 'x'] }))).toEqual({
      teams: [],
      managedTeams: ['x'],
    });
  });
});

describe('Session', () => {
  it('signs in, keeping the token in memory and the person with their teams', async () => {
    const response = sessionResponse({ teams: [TEAM], managedTeams: [TEAM] }, 'manager');
    const session = new Session(fakeIdentity({ login: () => Promise.resolve(response) }));
    await session.login('a@example.com', 'secret');
    expect(session.accessToken()).toBe(response.accessToken);
    expect(session.user).toEqual({
      id: ID,
      displayName: 'Ada',
      role: 'manager',
      teamIds: [TEAM],
      managedTeamIds: [TEAM],
    });
    expect(session.isManager).toBe(true);
    expect(session.isAdmin).toBe(false);
  });

  it('lets a failed login through to the caller and stays signed out', async () => {
    const session = new Session(
      fakeIdentity({
        login: () => Promise.reject(new ApiError(401, 'auth.invalid_credentials', 'Wrong')),
      }),
    );
    await expect(session.login('a@example.com', 'x')).rejects.toMatchObject({
      code: 'auth.invalid_credentials',
    });
    expect(session.user).toBeNull();
    expect(session.accessToken()).toBeNull();
  });

  it('keeps nothing in browser storage', async () => {
    const session = new Session(
      fakeIdentity({ login: () => Promise.resolve(sessionResponse({})) }),
    );
    await session.login('a@example.com', 'x');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  describe('restore (after a page reload)', () => {
    it('continues from the refresh cookie and marks the check as done', async () => {
      const session = new Session(
        fakeIdentity({ refresh: () => Promise.resolve(sessionResponse({}, 'admin')) }),
      );
      expect(session.ready).toBe(false);
      await session.restore();
      expect(session.ready).toBe(true);
      expect(session.isAdmin).toBe(true);
    });

    it('ends signed out, still marked done, when there is no cookie', async () => {
      const session = new Session(fakeIdentity());
      await session.restore();
      expect(session.ready).toBe(true);
      expect(session.user).toBeNull();
    });

    it('never throws, even for a network failure', async () => {
      const session = new Session(
        fakeIdentity({ refresh: () => Promise.reject(new TypeError('fetch failed')) }),
      );
      await expect(session.restore()).resolves.toBeUndefined();
      expect(session.ready).toBe(true);
    });
  });

  describe('refresh (after a 401)', () => {
    it('swaps in the new token', async () => {
      const first = sessionResponse({});
      const second = {
        ...sessionResponse({ teams: [TEAM] }),
        accessToken: jwt({ teams: [TEAM], n: 2 }),
      };
      let calls = 0;
      const session = new Session(
        fakeIdentity({
          login: () => Promise.resolve(first),
          refresh: () => Promise.resolve(++calls === 1 ? second : first),
        }),
      );
      await session.login('a@example.com', 'x');
      expect(await session.refresh()).toBe(true);
      expect(session.accessToken()).toBe(second.accessToken);
      expect(session.user?.teamIds).toEqual([TEAM]);
    });

    it('ends the session when the cookie is rejected', async () => {
      const session = new Session(
        fakeIdentity({
          login: () => Promise.resolve(sessionResponse({})),
          refresh: () => Promise.reject(new ApiError(401, 'auth.invalid_token', 'expired')),
        }),
      );
      await session.login('a@example.com', 'x');
      expect(await session.refresh()).toBe(false);
      expect(session.user).toBeNull();
      expect(session.accessToken()).toBeNull();
    });

    it('does not sign anyone out because of a network blip or a server error', async () => {
      const session = new Session(
        fakeIdentity({
          login: () => Promise.resolve(sessionResponse({})),
          refresh: () => Promise.reject(new ApiError(503, 'service.unavailable', 'later')),
        }),
      );
      await session.login('a@example.com', 'x');
      expect(await session.refresh()).toBe(false);
      expect(session.user).not.toBeNull();
    });
  });

  it('signs out locally even when the server cannot be reached', async () => {
    const session = new Session(
      fakeIdentity({
        login: () => Promise.resolve(sessionResponse({})),
        logout: () => Promise.reject(new TypeError('offline')),
      }),
    );
    await session.login('a@example.com', 'x');
    await expect(session.logout()).rejects.toThrow('offline');
    expect(session.user).toBeNull();
    expect(session.accessToken()).toBeNull();
  });
});
