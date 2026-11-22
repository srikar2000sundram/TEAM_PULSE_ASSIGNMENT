import { afterEach, describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import '../src/index.js';

/** Creates a custom element, sets properties (as a host would for objects) and waits for rendering. */
async function mount(tag: string, props: Record<string, unknown> = {}): Promise<HTMLElement> {
  const element = document.createElement(tag);
  Object.assign(element, props);
  document.body.append(element);
  await tick();
  await Promise.resolve();
  return element;
}

const root = (element: HTMLElement) => {
  if (element.shadowRoot === null) throw new Error('no shadow root');
  return element.shadowRoot;
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('custom elements are registered', () => {
  it.each([
    'tp-progress-ring',
    'tp-progress-card',
    'tp-leaderboard',
    'tp-trend-chart',
    'tp-filter-bar',
  ])('%s', (tag) => {
    expect(customElements.get(tag)).toBeDefined();
  });
});

describe('tp-progress-ring', () => {
  it('is a progressbar that shows its numbers as text, not only as a ring', async () => {
    const el = await mount('tp-progress-ring', { value: 3, max: 7, label: 'Days this week' });
    const bar = root(el).querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('3');
    expect(bar?.getAttribute('aria-valuemax')).toBe('7');
    expect(bar?.getAttribute('aria-valuetext')).toBe('3 / 7');
    expect(bar?.getAttribute('aria-label')).toBe('Days this week');
    expect(root(el).textContent).toContain('3 / 7');
  });

  it('never reports more than the maximum to assistive technology', async () => {
    const el = await mount('tp-progress-ring', { value: 12, max: 7 });
    expect(root(el).querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('7');
  });

  it('updates when a property changes', async () => {
    const el = await mount('tp-progress-ring', { value: 1, max: 10 });
    Object.assign(el, { value: 9 });
    await tick();
    expect(root(el).textContent).toContain('9 / 10');
  });

  it('reads attributes as numbers', async () => {
    const el = document.createElement('tp-progress-ring');
    el.setAttribute('value', '4');
    el.setAttribute('max', '8');
    document.body.append(el);
    await tick();
    expect(root(el).textContent).toContain('4 / 8');
  });
});

describe('tp-progress-card', () => {
  it('shows title, numbers and the trend in words', async () => {
    const el = await mount('tp-progress-card', {
      title: 'Weekly goal',
      value: 4,
      target: 5,
      trend: 'up',
    });
    const text = root(el).textContent ?? '';
    expect(text).toContain('Weekly goal');
    expect(text).toContain('4');
    expect(text).toContain('of 5');
    expect(text).toContain('rising');
  });

  it('raises a select event when pressed, which crosses the shadow boundary', async () => {
    const el = await mount('tp-progress-card', { title: 'Weekly goal', value: 1, target: 5 });
    const seen: unknown[] = [];
    document.body.addEventListener('select', (e) => seen.push((e as CustomEvent).detail));
    root(el).querySelector('button')?.click();
    expect(seen).toEqual([{ title: 'Weekly goal' }]);
  });

  it('omits the bar when there is no target', async () => {
    const el = await mount('tp-progress-card', { title: 'Total', value: 10, target: 0 });
    expect(root(el).querySelector('.bar')).toBeNull();
  });
});

describe('tp-leaderboard', () => {
  const rows = [
    { id: 'a', rank: 1, label: 'Ada', value: 14 },
    { id: 'b', rank: 2, label: 'Bo', value: 11 },
  ];

  it('is a table with column headers, and marks the current person in text', async () => {
    const el = await mount('tp-leaderboard', { rows, highlightId: 'b', metric: 'Points' });
    const headers = [...root(el).querySelectorAll('th')].map((th) => th.textContent);
    expect(headers).toEqual(['Rank', 'Name', 'Points']);
    const lines = [...root(el).querySelectorAll('tbody tr')];
    expect(lines).toHaveLength(2);
    expect(lines[1]?.getAttribute('aria-current')).toBe('true');
    expect(lines[1]?.textContent).toContain('(you)');
    expect(lines[0]?.getAttribute('aria-current')).toBeNull();
  });

  it('raises rowselect with the row', async () => {
    const el = await mount('tp-leaderboard', { rows });
    const seen: unknown[] = [];
    document.body.addEventListener('rowselect', (e) => seen.push((e as CustomEvent).detail));
    root(el)
      .querySelectorAll('tbody button')[0]
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen).toEqual([rows[0]]);
  });

  it('says so when nobody has scored', async () => {
    const el = await mount('tp-leaderboard', { rows: [] });
    expect(root(el).querySelector('table')).toBeNull();
    expect(root(el).textContent).toContain('Nobody has scored yet');
  });

  it('shows names as text, never as markup', async () => {
    const el = await mount('tp-leaderboard', {
      rows: [{ id: 'x', rank: 1, label: '<img src=x onerror=alert(1)>', value: 1 }],
    });
    expect(root(el).querySelector('img')).toBeNull();
    expect(root(el).textContent).toContain('<img');
  });
});

describe('tp-trend-chart', () => {
  const series = [
    { date: '2026-11-19', value: 2 },
    { date: '2026-11-20', value: 5 },
  ];

  it('draws one keyboard-operable point per day and offers the data as a table', async () => {
    const el = await mount('tp-trend-chart', {
      series,
      from: '2026-11-19',
      to: '2026-11-20',
      label: 'Completions',
    });
    const dots = [...root(el).querySelectorAll('circle.dot')];
    expect(dots).toHaveLength(2);
    expect(dots[0]?.getAttribute('tabindex')).toBe('0');
    expect(dots[1]?.getAttribute('aria-label')).toBe('2026-11-20: 5');
    expect([...root(el).querySelectorAll('tbody tr')].map((r) => r.textContent)).toEqual([
      '2026-11-192',
      '2026-11-205',
    ]);
    expect(root(el).querySelector('svg')?.getAttribute('aria-label')).toContain('2 days');
  });

  it('raises pointselect on click and on Enter', async () => {
    const el = await mount('tp-trend-chart', { series });
    const seen: unknown[] = [];
    document.body.addEventListener('pointselect', (e) => seen.push((e as CustomEvent).detail));
    const dot = root(el).querySelectorAll('circle.dot')[1] as SVGElement;
    dot.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    dot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    dot.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(seen).toEqual([
      { date: '2026-11-20', value: 5 },
      { date: '2026-11-20', value: 5 },
    ]);
  });

  it('says so when there is no data', async () => {
    const el = await mount('tp-trend-chart', { series: [] });
    expect(root(el).querySelector('svg')).toBeNull();
    expect(root(el).textContent).toContain('No data in this period');
  });
});

describe('tp-filter-bar', () => {
  const value = { activityType: 'all', status: 'all', from: '', to: '' };

  it('shows only the controls it has options for, and labels each one', async () => {
    const el = await mount('tp-filter-bar', { value, activityTypes: ['walking', 'yoga'] });
    const labels = [...root(el).querySelectorAll('label')].map((l) =>
      l.firstChild?.textContent?.trim(),
    );
    expect(labels).toEqual(['Activity', 'From', 'To']);
    expect([...root(el).querySelectorAll('select option')].map((o) => o.textContent)).toEqual([
      'All',
      'walking',
      'yoga',
    ]);
  });

  it('reports the whole new value and leaves the state to the host', async () => {
    const el = await mount('tp-filter-bar', {
      value: { ...value, status: 'active' },
      activityTypes: ['walking'],
      statuses: ['active'],
    });
    const seen: unknown[] = [];
    el.addEventListener('change', (e) => seen.push((e as CustomEvent).detail));
    const select = root(el).querySelector('select') as HTMLSelectElement;
    select.value = 'walking';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(seen).toEqual([{ activityType: 'walking', status: 'active', from: '', to: '' }]);
    // The component did not change its own value: the host decides.
    expect(select.value).toBe('walking');
  });

  it('stops a start date after the end date and the reverse', async () => {
    const el = await mount('tp-filter-bar', {
      value: { ...value, from: '2026-11-10', to: '2026-11-20' },
    });
    const [from, to] = root(el).querySelectorAll('input') as unknown as HTMLInputElement[];
    expect(from?.max).toBe('2026-11-20');
    expect(to?.min).toBe('2026-11-10');
  });
});
