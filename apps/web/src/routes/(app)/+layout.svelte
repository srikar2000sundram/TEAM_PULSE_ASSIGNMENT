<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { useApp } from '../../lib/context.js';

  let { children } = $props();
  const { api, session } = useApp();

  let unread = $state(0);

  // A usability guard only: the APIs enforce access themselves (ADR-0006).
  $effect(() => {
    if (session.ready && session.user === null) void goto('/login', { replaceState: true });
  });

  onMount(() => {
    // A failure here must never break the page: the count is a nicety.
    api.notifications.list({ unread: true, limit: 1 }).then(
      (result) => (unread = result.unreadCount),
      () => undefined,
    );
  });

  const links = $derived(
    [
      { href: '/dashboard', label: 'Dashboard', show: true },
      { href: '/habits', label: 'Habits', show: !session.isAdmin },
      { href: '/challenges', label: 'Challenges', show: true },
      { href: '/analytics/me', label: 'My activity', show: !session.isAdmin },
      { href: '/analytics/team', label: session.isAdmin ? 'Organisation' : 'Team', show: true },
    ].filter((link) => link.show),
  );

  async function logout() {
    await session.logout();
    void goto('/login');
  }
</script>

{#if session.user}
  <div class="shell">
    <a class="skip-link" href="#content">Skip to content</a>
    <header>
      <strong>TeamPulse</strong>
      <nav aria-label="Main">
        {#each links as link (link.href)}
          <a href={link.href} aria-current={page.url.pathname.startsWith(link.href) ? 'page' : undefined}>{link.label}</a>
        {/each}
      </nav>
      <span class="muted" aria-label="Unread notifications">🔔 {unread}</span>
      <span>{session.user.displayName}</span>
      <button class="secondary" type="button" onclick={logout}>Sign out</button>
    </header>
    <main id="content">{@render children()}</main>
  </div>
{:else if !session.ready}
  <p class="muted" style="padding: 1rem">Loading…</p>
{/if}
