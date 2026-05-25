// Side-effect module that registers every shipped agent strategy. Import this
// once from `index.ts` to make all strategies available via `getStrategy()`.
import { registerStrategy } from './index.js';
import { claudeStrategy, ensureClaudeHookFiles } from './claude.js';
import { copilotStrategy } from './copilot.js';

registerStrategy(claudeStrategy);
registerStrategy(copilotStrategy);

/** One-time setup for any agent that needs to write helper files (Claude's
 *  hook script + settings). Called by the server at startup. */
export function initAgentEnvironments(): void {
  ensureClaudeHookFiles();
}
