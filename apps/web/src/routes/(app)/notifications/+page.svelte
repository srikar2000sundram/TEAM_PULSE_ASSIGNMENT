<script lang="ts">
  import { onMount } from 'svelte';
  import { useApp } from '../../../lib/context.js';
  import { NotificationsState } from '../../../lib/features/notifications.svelte.js';
  import { titleCase } from '../../../lib/format.js';

  const { api } = useApp();
  const notifications = new NotificationsState(api.notifications);

  onMount(() => void notifications.load());
</script>

<svelte:head><title>Notifications · TeamPulse</title></svelte:head>

<h1>Notifications</h1>
<p class="muted">{notifications.unreadCount} unread</p>

{#if notifications.error}
  <p class="notice error" role="alert">{notifications.error}</p>
{/if}

{#if notifications.items.loading && !notifications.items.value}
  <p class="muted">Loading…</p>
{:else if notifications.items.error}
  <p class="notice error" role="alert">{notifications.items.error}</p>
{:else if (notifications.items.value ?? []).length === 0}
  <p class="muted">Nothing yet. Badges and milestones will show up here.</p>
{:else}
  <ul class="stack" style="list-style: none; padding: 0">
    {#each notifications.items.value ?? [] as item (item.id)}
      <li class="card row">
        <div style="flex: 1">
          <strong>{item.title}</strong>{#if item.readAt === undefined} <span class="muted">(new)</span>{/if}
          <div>{item.body}</div>
          <div class="muted">{titleCase(item.kind)} · {new Date(item.createdAt).toLocaleString()}</div>
        </div>
        {#if item.readAt === undefined}
          <button class="secondary" type="button" onclick={() => notifications.markRead(item)}>Mark as read</button>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
