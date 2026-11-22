/* eslint-disable @typescript-eslint/require-await -- test doubles return promises without awaiting */
import type { NotificationResponse } from '@teampulse/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/http.js';
import type { AdminApi, IdentityApi, NotificationApi } from '../api/index.js';
import { AdminState } from './admin.svelte.js';
import { NotificationsState } from './notifications.svelte.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = '2026-11-20T08:00:00.000Z';

describe('AdminState', () => {
  const user = (n: number) => ({
    id: id(n),
    email: `u${n}@example.com`,
    displayName: `User ${n}`,
    role: 'employee' as const,
    status: 'active' as const,
  });

  it('creates a user and then reloads the list', async () => {
    const calls: string[] = [];
    const admin = {
      users: async () => (calls.push('users'), { items: [user(1)] }),
      createUser: async () => (calls.push('create'), user(2)),
    } as unknown as AdminApi;
    const identity = { teams: async () => ({ items: [] }) } as unknown as IdentityApi;
    const state = new AdminState(admin, identity);
    await state.createUser({
      email: 'u2@example.com',
      displayName: 'User 2',
      role: 'employee',
      password: 'long-enough-password',
    });
    expect(calls).toEqual(['create', 'users']);
    expect(state.notice).toEqual({ kind: 'ok', text: 'Created User 2.' });
    expect(state.users.value).toHaveLength(1);
    expect(state.busy).toBe(false);
  });

  it('shows the server message when an action fails', async () => {
    const admin = {
      createUser: async () =>
        Promise.reject(new ApiError(409, 'user.exists', 'That e-mail is taken')),
    } as unknown as AdminApi;
    const state = new AdminState(admin, {} as IdentityApi);
    await state.createUser({ email: 'a@b.co', displayName: 'A', role: 'employee', password: 'x' });
    expect(state.notice).toEqual({ kind: 'error', text: 'That e-mail is taken' });
    expect(state.busy).toBe(false);
  });

  it('disables a user with a status change', async () => {
    let sent: unknown;
    const admin = {
      users: async () => ({ items: [user(1)] }),
      updateUser: async (_id: string, request: unknown) => ((sent = request), user(1)),
    } as unknown as AdminApi;
    const identity = { teams: async () => ({ items: [] }) } as unknown as IdentityApi;
    const state = new AdminState(admin, identity);
    await state.setStatus(user(1), 'disabled');
    expect(sent).toEqual({ status: 'disabled' });
    expect(state.notice?.text).toBe('Disabled User 1.');
  });
});

describe('NotificationsState', () => {
  const note = (n: number, readAt?: string): NotificationResponse => ({
    id: id(n),
    kind: 'badge',
    title: `Badge ${n}`,
    body: 'You earned it',
    createdAt: NOW,
    ...(readAt === undefined ? {} : { readAt }),
  });

  it('loads items and the unread count, and marking one read lowers the count', async () => {
    const api = {
      list: async () => ({ items: [note(1), note(2)], unreadCount: 2 }),
      markRead: async () => note(1, NOW),
    } as unknown as NotificationApi;
    const state = new NotificationsState(api);
    await state.load();
    expect(state.unreadCount).toBe(2);
    await state.markRead(note(1));
    expect(state.unreadCount).toBe(1);
    expect(state.items.value?.[0]?.readAt).toBe(NOW);
  });

  it('does not lower the count when the notification was already read', async () => {
    const api = {
      list: async () => ({ items: [note(1, NOW)], unreadCount: 0 }),
      markRead: async () => note(1, NOW),
    } as unknown as NotificationApi;
    const state = new NotificationsState(api);
    await state.load();
    await state.markRead(note(1, NOW));
    expect(state.unreadCount).toBe(0);
  });

  it('reports a failure without losing the list', async () => {
    const api = {
      list: async () => ({ items: [note(1)], unreadCount: 1 }),
      markRead: async () => Promise.reject(new ApiError(404, 'not_found', 'Not found')),
    } as unknown as NotificationApi;
    const state = new NotificationsState(api);
    await state.load();
    await state.markRead(note(1));
    expect(state.error).toBe('Not found');
    expect(state.items.value).toHaveLength(1);
  });
});
