// open-observe addition (not in expo-observe): one switch for the web collector, off until the app turns it on.
//
// While it is off the web collector queues nothing, sends nothing and has no listener or observer running; turning it off
// clears what was queued. The native module is not touched by it: expo-observe keeps sending exactly as before.
// No browser or native imports, so node can test it.
let enabled = false;
const listeners = new Set<(enabled: boolean) => void>();

export const isObserveEnabled = (): boolean => enabled;

/** Switches our own analytics on or off (default off). Only `true` switches it on. */
export function setObserveEnabled(value: boolean): void {
  const next = value === true;
  if (next === enabled) return;
  enabled = next;
  for (const listener of [...listeners]) {
    try { listener(next); } catch { /* a listener must not break the switch */ }
  }
}

/** For the web collector: called when the switch changes. Returns the unsubscribe function. */
export function subscribeObserveEnabled(listener: (enabled: boolean) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
