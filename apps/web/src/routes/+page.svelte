<script lang="ts">
  import { goto } from '$app/navigation';
  import { useApp } from '../lib/context.js';

  const { session } = useApp();

  // Wait for the first session check so a signed-in person is not sent to the login page.
  $effect(() => {
    if (!session.ready) return;
    void goto(session.user === null ? '/login' : '/dashboard', { replaceState: true });
  });
</script>

<p class="muted" style="padding: 1rem">Loading…</p>
