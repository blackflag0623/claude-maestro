/** Slim persisted state for the mobile client. Separate localStorage key from
 *  the desktop client to avoid colliding with its layout/pane state. */

export interface MobileServerEntry {
  id: string;
  name: string;
  baseUrl: string; // '' = current origin (the implicit "this device" server)
}

export interface MobileState {
  servers: MobileServerEntry[];
}

const KEY = 'maestro:mobile-state:v1';

const empty: MobileState = { servers: [] };

export function loadState(): MobileState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...empty };
    const parsed = JSON.parse(raw) as Partial<MobileState>;
    return { servers: Array.isArray(parsed.servers) ? parsed.servers : [] };
  } catch {
    return { ...empty };
  }
}

export function saveState(s: MobileState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
}

export { uuid } from '../client-shared/uuid';

/** The current origin is always available as an implicit, non-removable server. */
export const THIS_DEVICE: MobileServerEntry = {
  id: '__origin__',
  name: 'this device',
  baseUrl: '',
};
