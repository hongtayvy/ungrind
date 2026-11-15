import { ClaudeCodeRunner } from "./claude-code.js";
import { CodexRunner } from "./codex.js";
import { OllamaRunner } from "./ollama.js";

export const ADAPTERS = ["claude-code", "codex", "ollama"];

/**
 * Which agent runs a given tier for a given task. Precedence:
 *   task.agent  (card-level override)
 *   agent.byTier[tier]  (e.g. local -> ollama; a tier's model only makes sense on its adapter)
 *   agent.byType[task.type]  (e.g. ui -> codex)
 *   agent.adapter  (default: claude-code)
 */
export function agentFor(config, task, tier) {
  if (task?.agent) return task.agent; // a card can override the rules, e.g. go straight to Codex
  return config.agent.byTier[tier] ?? (task?.type ? config.agent.byType[task.type] : null) ?? config.agent.adapter;
}

/** Model id for (adapter, tier). Claude tiers use routing.models; others use agent.<adapter>.models. Null = adapter default. */
export function modelFor(config, adapter, tier) {
  if (adapter === "claude-code") return config.routing.models[tier] ?? null;
  const models = config.agent[adapter]?.models ?? {};
  // Ollama needs a concrete model on every rung a card forces it onto.
  return models[tier] ?? (adapter === "ollama" ? Object.values(models)[0] ?? null : null);
}

/** Where a task starts on the ladder: the card's own `tier`, else its size label, else the default. */
export function startTier(config, task) {
  const t = task?.tier ?? config.routing.tierBySize[task?.size] ?? config.routing.defaultTier;
  return config.routing.ladder.includes(t) ? t : config.routing.ladder[0];
}

/** Problems with a card's route overrides, checked against the project's rules. */
export function routeProblems(config, task) {
  const out = [];
  if (task.tier && !config.routing.ladder.includes(task.tier)) out.push(`tier "${task.tier}" is not on the ladder (${config.routing.ladder.join(", ")})`);
  if (task.agent && !ADAPTERS.includes(task.agent)) out.push(`unknown agent "${task.agent}" (use ${ADAPTERS.join(", ")})`);
  if (task.agent === "ollama" && !Object.keys(config.agent.ollama?.models ?? {}).length) out.push("agent ollama has no models in agent.ollama.models");
  return out;
}

/** Lazily builds one runner per adapter. `deps.<adapter>` lets tests inject fakes. */
export function createRunners(config, deps = {}) {
  const cache = new Map();
  return {
    get(adapter) {
      if (deps[adapter]) return deps[adapter];
      if (!cache.has(adapter)) {
        if (adapter === "claude-code") cache.set(adapter, new ClaudeCodeRunner(config.agent));
        else if (adapter === "codex") cache.set(adapter, new CodexRunner({ ...config.agent.codex, unsetEnv: config.agent.unsetEnv }));
        else if (adapter === "ollama") cache.set(adapter, new OllamaRunner({ ...config.agent.ollama, unsetEnv: config.agent.unsetEnv }));
        else throw new Error(`Unknown agent adapter: ${adapter} (use ${ADAPTERS.join(", ")})`);
      }
      return cache.get(adapter);
    },
  };
}

/** Wrap a single runner so every adapter resolves to it (tests, simple setups). */
export const singleRunner = (runner) => ({ get: () => runner });
