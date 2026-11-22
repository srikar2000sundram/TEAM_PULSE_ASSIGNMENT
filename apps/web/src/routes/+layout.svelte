<script lang="ts">
  import '../app.css';
  import '@teampulse/ui';
  import { onMount } from 'svelte';
  import { createApi, type Api } from '../lib/api/index.js';
  import { Session } from '../lib/auth/session.svelte.js';
  import { provideApp } from '../lib/context.js';

  let { children } = $props();

  // The session needs the identity API, which needs the session as its token source: build the
  // identity client first with a late-bound token source, then the rest of the API.
  const holder: { session?: Session } = {};
  const tokens = {
    accessToken: () => holder.session?.accessToken() ?? null,
    refresh: () => holder.session?.refresh() ?? Promise.resolve(false),
  };
  const api: Api = createApi(tokens);
  const session = new Session(api.identity);
  holder.session = session;
  provideApp({ api, session });

  onMount(() => void session.restore());
</script>

{@render children()}
