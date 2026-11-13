import { ClaudeCodeRunner } from "./claude-code.js";
import { CodexRunner } from "./codex.js";
import { OllamaRunner } from "./ollama.js";

export const ADAPTERS = ["claude-code", "codex", "ollama"];

/**
 * Which agent runs a given tier for a given task. Precedence:
 *   agent.byTier[tier]  (e.g. local -> ollama; a tier's model only makes sense on its adapter)
 *   agent.byType[task.type]  (e.g. ui -> codex)
 *   agent.adapter  (default: claude-code)
 */
export function agentFor(config, task, tier) {
  return config.agent.byTier[tier] ?? (task?.type ? config.agent.byType[task.type] : null) ?? config.agent.adapter;
}

/** Model id for (adapter, tier). Claude tiers use routing.models; others use agent.<adapter>.models. Null = adapter default. */
export function modelFor(config, adapter, tier) {
  if (adapter === "claude-code") return config.routing.models[tier] ?? null;
  return config.agent[adapter]?.models?.[tier] ?? null;
}

/** Lazily builds one runner per adapter. `deps.<adapter>` lets tests inject fakes. */
export function createRunners(config, deps = {}) {
  const cache = new Map();
  return {
    get(adapter) {
      if (deps[adapter]) return deps[adapter];
      if (!cache.has(adapter)) {
        if (adapter === "claude-code") cache.set(adapter, new ClaudeCodeRunner(config.agent));
        else if (adapter === "codex") cache.set(adapter, new CodexRunner(config.agent.codex));
        else if (adapter === "ollama") cache.set(adapter, new OllamaRunner(config.agent.ollama));
        else throw new Error(`Unknown agent adapter: ${adapter} (use ${ADAPTERS.join(", ")})`);
      }
      return cache.get(adapter);
    },
  };
}

/** Wrap a single runner so every adapter resolves to it (tests, simple setups). */
export const singleRunner = (runner) => ({ get: () => runner });
