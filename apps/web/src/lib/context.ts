import { getContext, setContext } from 'svelte';
import type { Api } from './api/index.js';
import type { Session } from './auth/session.svelte.js';

export interface AppContext {
  readonly api: Api;
  readonly session: Session;
}

const KEY = Symbol('teampulse');

/** The root layout provides this once; everything below asks for it. Tests provide fakes. */
export const provideApp = (app: AppContext): void => void setContext(KEY, app);

export function useApp(): AppContext {
  const app = getContext<AppContext | undefined>(KEY);
  if (app === undefined) throw new Error('The app context is missing: provideApp() was not called');
  return app;
}
