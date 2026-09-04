import { ensureGlobalStore } from '../store/global-store.js';

/** `knowl init --global`: the machine-wide store, and nothing about any checkout. */
export async function runGlobalInit(): Promise<{ path: string; created: boolean }> {
  return ensureGlobalStore();
}
