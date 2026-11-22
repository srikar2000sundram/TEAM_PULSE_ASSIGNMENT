import { messageOf } from './format.js';

/**
 * A value that is loaded asynchronously, with its loading and error state.
 *
 * Latest wins: if `load` is called again before the first call finished (a person changing filters
 * quickly), the older response is dropped when it arrives, so a slow early answer can never
 * overwrite a newer one.
 */
export class AsyncValue<T> {
  value = $state<T | undefined>(undefined);
  loading = $state(false);
  error = $state<string | null>(null);

  private generation = 0;

  async load(fetcher: () => Promise<T>): Promise<void> {
    const mine = ++this.generation;
    this.loading = true;
    this.error = null;
    try {
      const result = await fetcher();
      if (mine === this.generation) this.value = result;
    } catch (error) {
      if (mine === this.generation) this.error = messageOf(error);
    } finally {
      if (mine === this.generation) this.loading = false;
    }
  }
}
