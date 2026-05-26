import type { AgentType } from '../shared/protocol';

/** Full human-readable agent name used in tooltips, headers, status text. */
export function agentLabel(a: AgentType): string {
  return a === 'copilot' ? 'GitHub Copilot CLI' : 'Claude Code';
}

/** Short agent name for inline status (e.g. "Claude is working…"). */
export function agentShort(a: AgentType): string {
  return a === 'copilot' ? 'Copilot' : 'Claude';
}
