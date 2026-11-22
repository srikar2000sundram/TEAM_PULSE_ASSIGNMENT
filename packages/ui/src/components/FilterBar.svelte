<svelte:options
  customElement={{
    tag: 'tp-filter-bar',
    shadow: 'open',
    props: {
      value: { type: 'Object' },
      activityTypes: { type: 'Array', attribute: 'activity-types' },
      statuses: { type: 'Array' },
    },
  }}
/>

<script lang="ts" module>
  export interface FilterValue {
    activityType: string;
    status: string;
    from: string;
    to: string;
  }
</script>

<script lang="ts">
  let {
    value = { activityType: 'all', status: 'all', from: '', to: '' },
    activityTypes = [],
    statuses = [],
  }: { value?: FilterValue; activityTypes?: string[]; statuses?: string[] } = $props();

  const element = $host();

  /** Reports the new value; the host owns the state (props in, events out). */
  function change(patch: Partial<FilterValue>) {
    element.dispatchEvent(
      new CustomEvent('change', { detail: { ...value, ...patch }, bubbles: true, composed: true }),
    );
  }
</script>

<form class="bar" onsubmit={(e) => e.preventDefault()}>
  {#if activityTypes.length > 0}
    <label>Activity
      <select value={value.activityType} onchange={(e) => change({ activityType: e.currentTarget.value })}>
        <option value="all">All</option>
        {#each activityTypes as type (type)}<option value={type}>{type}</option>{/each}
      </select>
    </label>
  {/if}
  {#if statuses.length > 0}
    <label>Status
      <select value={value.status} onchange={(e) => change({ status: e.currentTarget.value })}>
        <option value="all">All</option>
        {#each statuses as status (status)}<option value={status}>{status}</option>{/each}
      </select>
    </label>
  {/if}
  <label>From
    <input type="date" value={value.from} max={value.to || undefined} onchange={(e) => change({ from: e.currentTarget.value })} />
  </label>
  <label>To
    <input type="date" value={value.to} min={value.from || undefined} onchange={(e) => change({ to: e.currentTarget.value })} />
  </label>
</form>

<style>
  .bar { display: flex; flex-wrap: wrap; gap: var(--tp-space-3); font-family: var(--tp-font-family); color: var(--tp-color-text); }
  label { display: flex; flex-direction: column; gap: var(--tp-space-1); font-size: var(--tp-font-size-1); color: var(--tp-color-text-muted); }
  select, input { font: inherit; color: var(--tp-color-text); background: var(--tp-color-bg); border: 1px solid var(--tp-color-border); border-radius: var(--tp-radius-1); padding: var(--tp-space-2); }
  select:focus-visible, input:focus-visible { outline: 3px solid var(--tp-color-focus); outline-offset: 1px; }
</style>
