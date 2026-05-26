// Side-effect module that registers every shipped agent strategy. Import this
// once from `index.ts` to make all strategies available via `getStrategy()`.
import { registerStrategy } from './index.js';
import { claudeStrategy, ensureClaudeHookFiles } from './claude.js';
import { copilotStrategy } from './copilot.js';

registerStrategy(claudeStrategy);
registerStrategy(copilotStrategy);

/** One-time setup for any agent that needs to write helper files (Claude's
 *  hook script + settings). Called after the HTTP server is bound, so the
 *  port baked into the hook URL matches what was actually claimed. */
export function initAgentEnvironments(port: number): void {
  ensureClaudeHookFiles(port);
}
