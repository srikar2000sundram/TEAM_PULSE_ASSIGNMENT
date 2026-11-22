<script lang="ts">
  import { goto } from '$app/navigation';
  import { roles, type Role } from '@teampulse/contracts';
  import { onMount } from 'svelte';
  import { useApp } from '../../../lib/context.js';
  import { AdminState } from '../../../lib/features/admin.svelte.js';
  import { titleCase } from '../../../lib/format.js';

  const { api, session } = useApp();
  const admin = new AdminState(api.admin, api.identity);

  let email = $state('');
  let displayName = $state('');
  let role = $state<Role>('employee');
  let password = $state('');

  let teamName = $state('');
  let managerId = $state('');

  let memberTeamId = $state('');
  let memberUserId = $state('');

  const managers = $derived((admin.users.value ?? []).filter((user) => user.role === 'manager'));

  onMount(() => {
    // A usability guard only: the Identity API refuses everyone but administrators (ADR-0006).
    if (!session.isAdmin) {
      void goto('/dashboard', { replaceState: true });
      return;
    }
    void admin.load();
  });

  async function createUser(event: SubmitEvent) {
    event.preventDefault();
    await admin.createUser({ email, displayName, role, password });
    if (admin.notice?.kind === 'ok') {
      email = '';
      displayName = '';
      password = '';
    }
  }

  async function createTeam(event: SubmitEvent) {
    event.preventDefault();
    await admin.createTeam(teamName, managerId);
    if (admin.notice?.kind === 'ok') teamName = '';
  }

  async function addMember(event: SubmitEvent) {
    event.preventDefault();
    const team = (admin.teams.value ?? []).find((item) => item.id === memberTeamId);
    if (team) await admin.addMember(team, memberUserId);
  }
</script>

<svelte:head><title>Administration · TeamPulse</title></svelte:head>

<h1>Administration</h1>

{#if admin.notice}
  <p class="notice {admin.notice.kind}" role={admin.notice.kind === 'error' ? 'alert' : 'status'}>{admin.notice.text}</p>
{/if}

<h2>Add a person</h2>
<form class="card row" onsubmit={createUser}>
  <label class="field">E-mail
    <input type="email" required bind:value={email} autocomplete="off" />
  </label>
  <label class="field">Name
    <input required maxlength="100" bind:value={displayName} />
  </label>
  <label class="field">Role
    <select bind:value={role}>
      {#each roles as item (item)}<option value={item}>{titleCase(item)}</option>{/each}
    </select>
  </label>
  <label class="field">First password (12 or more characters)
    <input type="password" required minlength="12" maxlength="128" bind:value={password} autocomplete="new-password" />
  </label>
  <button class="primary" type="submit" disabled={admin.busy}>Add person</button>
</form>

<h2>People</h2>
{#if admin.users.error}
  <p class="notice error" role="alert">{admin.users.error}</p>
{:else if (admin.users.value ?? []).length === 0}
  <p class="muted">{admin.users.loading ? 'Loading…' : 'No people yet.'}</p>
{:else}
  <ul class="stack" style="list-style: none; padding: 0">
    {#each admin.users.value ?? [] as user (user.id)}
      <li class="card row">
        <div style="flex: 1">
          <strong>{user.displayName}</strong>
          <div class="muted">{user.email} · {titleCase(user.role)} · {user.status}</div>
        </div>
        {#if user.id !== session.user?.id}
          <button class="secondary" type="button" disabled={admin.busy}
            onclick={() => admin.setStatus(user, user.status === 'active' ? 'disabled' : 'active')}>
            {user.status === 'active' ? 'Disable' : 'Enable'}
          </button>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<h2>Teams</h2>
<form class="card row" onsubmit={createTeam}>
  <label class="field">Team name
    <input required maxlength="100" bind:value={teamName} />
  </label>
  <label class="field">Manager
    <select required bind:value={managerId}>
      <option value="" disabled>Choose a manager</option>
      {#each managers as manager (manager.id)}<option value={manager.id}>{manager.displayName}</option>{/each}
    </select>
  </label>
  <button class="primary" type="submit" disabled={admin.busy}>Create team</button>
</form>

<form class="card row" onsubmit={addMember}>
  <label class="field">Team
    <select required bind:value={memberTeamId}>
      <option value="" disabled>Choose a team</option>
      {#each admin.teams.value ?? [] as team (team.id)}<option value={team.id}>{team.name}</option>{/each}
    </select>
  </label>
  <label class="field">Person
    <select required bind:value={memberUserId}>
      <option value="" disabled>Choose a person</option>
      {#each admin.users.value ?? [] as user (user.id)}<option value={user.id}>{user.displayName}</option>{/each}
    </select>
  </label>
  <button class="primary" type="submit" disabled={admin.busy}>Add to team</button>
</form>

{#if (admin.teams.value ?? []).length > 0}
  <ul class="stack" style="list-style: none; padding: 0">
    {#each admin.teams.value ?? [] as team (team.id)}
      <li class="card">
        <strong>{team.name}</strong>
        <span class="muted"> · {team.memberCount} members</span>
      </li>
    {/each}
  </ul>
{/if}
