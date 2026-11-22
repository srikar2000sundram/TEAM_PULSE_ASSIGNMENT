<script lang="ts">
  import { goto } from '$app/navigation';
  import { useApp } from '../../lib/context.js';
  import { messageOf } from '../../lib/format.js';

  const { session } = useApp();

  let email = $state('');
  let password = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);

  // Already signed in (for example after a reload): nothing to do here.
  $effect(() => {
    if (session.user !== null) void goto('/dashboard', { replaceState: true });
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = null;
    try {
      await session.login(email, password);
    } catch (e) {
      // The server gives the same message for a wrong email and a wrong password.
      error = messageOf(e);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Sign in · TeamPulse</title></svelte:head>

<main style="max-width: 24rem; margin: 4rem auto; padding: 0 1rem">
  <h1>TeamPulse</h1>
  <form class="card stack" onsubmit={submit}>
    <label class="field">Email
      <input type="email" autocomplete="username" required bind:value={email} />
    </label>
    <label class="field">Password
      <input type="password" autocomplete="current-password" required bind:value={password} />
    </label>
    {#if error}<p class="notice error" role="alert">{error}</p>{/if}
    <button class="primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
  </form>
</main>
