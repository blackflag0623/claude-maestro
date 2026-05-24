import { renderServerPicker } from './server-picker';
import { renderSessionPicker } from './session-picker';
import { renderChat } from './chat';
import type { MobileServerEntry } from './mobile-state';

type Route =
  | { kind: 'servers' }
  | { kind: 'sessions'; server: MobileServerEntry }
  | { kind: 'chat'; server: MobileServerEntry; sessionId: string };

const root = document.getElementById('app')!;
let current: Route = { kind: 'servers' };

function go(next: Route) {
  current = next;
  paint();
}

function paint() {
  if (current.kind === 'servers') {
    renderServerPicker(root, {
      onPick: (server) => go({ kind: 'sessions', server }),
    });
  } else if (current.kind === 'sessions') {
    renderSessionPicker(root, current.server, {
      onPickSession: (sessionId) => go({ kind: 'chat', server: (current as { server: MobileServerEntry }).server, sessionId }),
      onBack: () => go({ kind: 'servers' }),
    });
  } else {
    renderChat(root, current.server, current.sessionId, {
      onBack: () => go({ kind: 'sessions', server: (current as { server: MobileServerEntry }).server }),
    });
  }
}

paint();
