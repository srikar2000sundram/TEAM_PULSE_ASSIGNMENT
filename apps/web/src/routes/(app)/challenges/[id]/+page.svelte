<script lang="ts">
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { useApp } from '../../../../lib/context.js';
  import { ChallengeDetail } from '../../../../lib/features/challenges.svelte.js';
  import { titleCase } from '../../../../lib/format.js';

  const { api, session } = useApp();
  const detail = new ChallengeDetail(api.challenges, api.identity, page.params['id'] ?? '');

  onMount(() => void detail.load());

  const challenge = $derived(detail.challenge.value);
  const canManage = $derived(
    challenge !== undefined &&
      (session.isAdmin || (session.user?.managedTeamIds.includes(challenge.teamId) ?? false)),
  );
  const canJoin = $derived(
    challenge !== undefined &&
      challenge.status === 'active' &&
      !challenge.joined &&
      (session.user?.teamIds.includes(challenge.teamId) ?? false),
  );
  const target = $derived(Math.max(...(challenge?.badgeRules.map((r) => r.threshold) ?? [0]), 0));
</script>

<svelte:head><title>{challenge?.name ?? 'Challenge'} · TeamPulse</title></svelte:head>

<p><a href="/challenges">← All challenges</a></p>

{#if detail.challenge.error}
  <p class="notice error" role="alert">{detail.challenge.error}</p>
{:else if challenge}
  <h1>{challenge.name}</h1>
  <p class="muted">
    {titleCase(challenge.activityType)} · {challenge.startsOn} to {challenge.endsOn} ·
    <span class="badge">{challenge.status}</span> · {challenge.participantCount} taking part
  </p>

  {#if detail.notice}
    <p class="notice {detail.notice.kind}" role={detail.notice.kind === 'error' ? 'alert' : 'status'}>{detail.notice.text}</p>
  {/if}

  <div class="row">
    {#if canJoin}<button class="primary" type="button" onclick={detail.join}>Join</button>{/if}
    {#if canManage && challenge.status === 'draft'}<button class="primary" type="button" onclick={detail.start}>Start now</button>{/if}
    {#if canManage && (challenge.status === 'draft' || challenge.status === 'active')}
      <button class="secondary" type="button" onclick={detail.cancel}>Cancel challenge</button>
    {/if}
  </div>

  {#if challenge.joined && detail.progress.value}
    <h2>Your progress</h2>
    <div class="grid">
      <div class="card row">
        <tp-progress-ring value={detail.progress.value.points} max={Math.max(target, detail.progress.value.points, 1)} label="points"></tp-progress-ring>
      </div>
      <div class="card stack">
        <span>Active days: <strong>{detail.progress.value.activeDays}</strong></span>
        <span>Longest streak: <strong>{detail.progress.value.longestStreak}</strong></span>
      </div>
    </div>
    {#if detail.progress.value.badges.length > 0}
      <h2>Badges</h2>
      <ul class="row" style="list-style: none; padding: 0">
        {#each detail.progress.value.badges as badge (badge.badgeRuleId)}
          <li class="badge">🏅 {titleCase(badge.kind)} {badge.threshold} · {badge.awardedOn}</li>
        {/each}
      </ul>
    {/if}
  {/if}

  <h2>Standings</h2>
  {#if detail.board.error}
    <p class="muted">The standings are for people taking part in this challenge.</p>
  {:else}
    <tp-leaderboard rows={detail.rows} highlightId={session.user?.id ?? ''} metric="Points"></tp-leaderboard>
  {/if}

  {#if challenge.badgeRules.length > 0}
    <h2>Badges to earn</h2>
    <ul>
      {#each challenge.badgeRules as rule (rule.id)}
        <li>{rule.kind === 'streak' ? `${rule.threshold} days in a row` : rule.kind === 'total' ? `${rule.threshold} activities` : `${rule.threshold} different active days`}</li>
      {/each}
    </ul>
  {/if}
{:else}
  <p class="muted">Loading…</p>
{/if}
