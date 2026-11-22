<script lang="ts">
  import { activityTypes, challengeStatuses, type ActivityType } from '@teampulse/contracts';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { useApp } from '../../../lib/context.js';
  import { ChallengeFilters, ChallengesState } from '../../../lib/features/challenges.svelte.js';
  import { localDate, titleCase } from '../../../lib/format.js';

  const { api, session } = useApp();
  const challengesState = new ChallengesState(api.challenges);

  // The address bar is the source of the filters, so a filtered view can be shared and the back
  // button works.
  challengesState.filters = ChallengeFilters.fromParams(page.url.searchParams, {
    types: activityTypes,
    statuses: challengeStatuses,
  });

  onMount(() => void challengesState.load());

  function onFilterChange(event: Event) {
    const value = (event as CustomEvent<{ activityType: string; status: string; from: string; to: string }>).detail;
    challengesState.filters.activityType = value.activityType as ActivityType | 'all';
    challengesState.filters.status = value.status as (typeof challengeStatuses)[number] | 'all';
    challengesState.filters.from = value.from;
    challengesState.filters.to = value.to;
    const query = new URLSearchParams(challengesState.filters.params).toString();
    void goto(query === '' ? '/challenges' : `/challenges?${query}`, { replaceState: true });
  }

  const filterValue = $derived({
    activityType: challengesState.filters.activityType,
    status: challengesState.filters.status,
    from: challengesState.filters.from,
    to: challengesState.filters.to,
  });

  // Create form (managers and administrators).
  const canCreate = $derived(session.isAdmin || (session.user?.managedTeamIds.length ?? 0) > 0);
  let name = $state('');
  let createType = $state<ActivityType>('walking');
  let teamId = $state('');
  let startsOn = $state(localDate());
  let endsOn = $state('');
  let teamNames = $state<Record<string, string>>({});

  onMount(async () => {
    if (!canCreate) return;
    try {
      const { items } = await api.identity.teams();
      teamNames = Object.fromEntries(items.map((t) => [t.id, t.name]));
      const managed = session.isAdmin ? items.map((t) => t.id) : (session.user?.managedTeamIds ?? []);
      teamId = managed[0] ?? '';
    } catch {
      /* the form simply stays without team names */
    }
  });

  const creatableTeams = $derived(
    Object.keys(teamNames).filter((id) => session.isAdmin || session.user?.managedTeamIds.includes(id)),
  );

  async function create(event: SubmitEvent) {
    event.preventDefault();
    const ok = await challengesState.create({ name, activityType: createType, teamId, startsOn, endsOn, badgeRules: [] });
    if (ok) name = '';
  }
</script>

<svelte:head><title>Challenges · TeamPulse</title></svelte:head>

<h1>Challenges</h1>

{#if challengesState.notice}
  <p class="notice {challengesState.notice.kind}" role={challengesState.notice.kind === 'error' ? 'alert' : 'status'}>{challengesState.notice.text}</p>
{/if}

<tp-filter-bar value={filterValue} activityTypes={[...activityTypes]} statuses={[...challengeStatuses]} onchange={onFilterChange}></tp-filter-bar>

{#if challengesState.list.loading && !challengesState.list.value}
  <p class="muted">Loading…</p>
{:else if challengesState.list.error}
  <p class="notice error" role="alert">{challengesState.list.error}</p>
{:else if challengesState.visible.length === 0}
  <p class="muted">No challenges match.</p>
{:else}
  <ul class="grid" style="list-style: none; padding: 0; margin-top: 1rem">
    {#each challengesState.visible as challenge (challenge.id)}
      <li class="card stack">
        <a href="/challenges/{challenge.id}"><strong>{challenge.name}</strong></a>
        <span class="muted">{titleCase(challenge.activityType)} · {challenge.startsOn} to {challenge.endsOn}</span>
        <span><span class="badge">{challenge.status}</span> {challenge.participantCount} taking part</span>
        {#if challenge.status === 'active' && !challenge.joined && session.user?.teamIds.includes(challenge.teamId)}
          <button class="primary" type="button" onclick={() => challengesState.join(challenge)}>Join</button>
        {:else if challenge.joined}
          <span class="muted">You are taking part ✓</span>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

{#if canCreate}
  <h2>Create a challenge</h2>
  <form class="card row" onsubmit={create}>
    <label class="field">Name <input required maxlength="80" bind:value={name} /></label>
    <label class="field">Activity
      <select bind:value={createType}>{#each activityTypes as type (type)}<option value={type}>{titleCase(type)}</option>{/each}</select>
    </label>
    <label class="field">Team
      <select required bind:value={teamId}>{#each creatableTeams as id (id)}<option value={id}>{teamNames[id]}</option>{/each}</select>
    </label>
    <label class="field">Starts <input type="date" required bind:value={startsOn} /></label>
    <label class="field">Ends <input type="date" required min={startsOn} bind:value={endsOn} /></label>
    <button class="primary" type="submit">Create draft</button>
  </form>
{/if}
