import type { NotificationResponse } from '@teampulse/contracts';
import { AsyncValue } from '../async.svelte.js';
import type { NotificationApi } from '../api/index.js';
import { messageOf } from '../format.js';

/** Your notifications: list, and mark one as read. */
export class NotificationsState {
  readonly items = new AsyncValue<NotificationResponse[]>();
  unreadCount = $state(0);
  error = $state<string | null>(null);

  constructor(private readonly api: NotificationApi) {}

  async load(): Promise<void> {
    await this.items.load(async () => {
      const result = await this.api.list({ limit: 50 });
      this.unreadCount = result.unreadCount;
      return result.items;
    });
  }

  async markRead(notification: NotificationResponse): Promise<void> {
    this.error = null;
    try {
      const updated = await this.api.markRead(notification.id);
      this.items.value = (this.items.value ?? []).map((item) =>
        item.id === updated.id ? updated : item,
      );
      if (notification.readAt === undefined) this.unreadCount = Math.max(0, this.unreadCount - 1);
    } catch (error) {
      this.error = messageOf(error);
    }
  }
}
