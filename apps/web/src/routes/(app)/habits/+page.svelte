<script lang="ts">
  import { activityTypes, type ActivityType } from '@teampulse/contracts';
  import { onMount } from 'svelte';
  import { useApp } from '../../../lib/context.js';
  import { HabitsState } from '../../../lib/features/habits.svelte.js';
  import { titleCase } from '../../../lib/format.js';

  const { api } = useApp();
  const habitsState = new HabitsState(api.habits, api.activities);

  let title = $state('');
  let activityType = $state<ActivityType>('walking');

  onMount(() => void habitsState.load());

  async function create(event: SubmitEvent) {
    event.preventDefault();
    await habitsState.create({ title, activityType });
    if (habitsState.notice?.kind === 'ok') title = '';
  }
</script>

<svelte:head><title>Habits · TeamPulse</title></svelte:head>

<h1>Your habits</h1>

{#if habitsState.notice}
  <p class="notice {habitsState.notice.kind}" role={habitsState.notice.kind === 'error' ? 'alert' : 'status'}>{habitsState.notice.text}</p>
{/if}

<form class="card row" onsubmit={create}>
  <label class="field">New habit
    <input required maxlength="80" bind:value={title} placeholder="Walk after lunch" />
  </label>
  <label class="field">Type
    <select bind:value={activityType}>
      {#each activityTypes as type (type)}<option value={type}>{titleCase(type)}</option>{/each}
    </select>
  </label>
  <button class="primary" type="submit" disabled={habitsState.busy}>Add habit</button>
</form>

<h2>Today</h2>
{#if habitsState.habits.loading && !habitsState.habits.value}
  <p class="muted">Loading…</p>
{:else if habitsState.habits.error}
  <p class="notice error" role="alert">{habitsState.habits.error}</p>
{:else if (habitsState.habits.value ?? []).length === 0}
  <p class="muted">No habits yet. Add one above.</p>
{:else}
  <ul class="stack" style="list-style: none; padding: 0">
    {#each habitsState.habits.value ?? [] as habit (habit.id)}
      <li class="card row">
        <div style="flex: 1">
          <strong>{habit.title}</strong>
          <div class="muted">{titleCase(habit.activityType)} · {habit.visibility === 'team' ? 'shared with your team' : 'private'}</div>
        </div>
        <button class="primary" type="button" disabled={habitsState.busy} onclick={() => habitsState.markDone(habit)}>
          {habitsState.done.has(habit.id) ? 'Done ✓' : 'Done today'}
        </button>
        <button class="secondary" type="button" disabled={habitsState.busy} onclick={() => habitsState.archive(habit)}>Archive</button>
      </li>
    {/each}
  </ul>
{/if}
