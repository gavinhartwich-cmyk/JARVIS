/**
 * Intent / Complexity Router (architecture update sections 1, 2, 9)
 *
 * Classifies an utterance into one of four paths *before* anything
 * expensive runs:
 *
 *   FAST      — direct conversational response (today: one model call).
 *   TOOL      — a known, deterministic action. No LLM call at all —
 *               section 8 is explicit that JARVIS should not spend a model
 *               call "translating" an action it already knows how to
 *               perform into another representation.
 *   REASONING — needs more than a one-shot answer (comparisons,
 *               trade-offs, "should I...") but not the full multi-agent
 *               pipeline. Currently a scoped-down placeholder: same single
 *               model call as FAST, with a system prompt that asks for
 *               actual reasoning instead of a quick take. It does not yet
 *               call any retrieval/tool augmentation — there isn't a real
 *               tool for it to call yet (see architecture doc step 4+).
 *               Revisit once REASONING has something concrete to reach for.
 *   DEEP      — the existing multi-agent pipeline (Orchestrator.orchestrate).
 *
 * Classification itself is pattern-based, not a model call — the router
 * has to be cheap enough that using it never costs more than skipping it
 * would have saved.
 */

export type IntentPath = "fast" | "tool" | "reasoning" | "deep";

export interface KnownAction {
  name: "open_app" | "close_app";
  target: string;
}

export interface IntentRoute {
  path: IntentPath;
  action?: KnownAction;
  reason: string;
}

// Deliberately narrow: only app open/close are wired to a real deterministic
// executor today (phase3/screen-control.ts). Extending this to more verbs
// (play/set/call/...) belongs with actually building/registering the
// executor for each — see architecture doc step 8 (capability registry) —
// not with guessing here that something exists when it doesn't.
const OPEN_APP_PATTERN = /^\s*(?:please\s+)?(?:open|launch|start)\s+(.+?)\s*[.!]?\s*$/i;
const CLOSE_APP_PATTERN = /^\s*(?:please\s+)?(?:close|quit|exit)\s+(.+?)\s*[.!]?\s*$/i;

// Multi-step / thorough-analysis signals — the shape of request the
// existing 5-agent pipeline (Researcher/Reasoner/Critic/FactChecker/
// Synthesizer) is actually built for, not a quick conversational reply.
const DEEP_PATTERN =
  /\b(research|deep[- ]dive|in[- ]depth|thoroughly|comprehensive|write a report|write an? (essay|analysis)|step[- ]by[- ]step plan|multi[- ]step)\b/i;
const SEQUENTIAL_CLAUSE_PATTERN = /\b(and then|after that|once that'?s? done|next,? )\b/i;
const DEEP_LENGTH_FLOOR = 220; // characters — a genuinely long request, not just a wordy question

// Moderate signals: wants a comparison or judgment call, not just a fact.
const REASONING_PATTERN = /\b(pros and cons|trade-?offs?|compare .+ (and|vs\.?|versus) .+|should i)\b/i;
const REASONING_LENGTH_FLOOR = 40; // avoid tripping on a bare "compare" with nothing to compare

function extractTarget(raw: string): string {
  return raw.trim().replace(/^(the|my|a|an)\s+/i, "");
}

export function classifyIntent(utterance: string): IntentRoute {
  const trimmed = utterance.trim();

  const openMatch = trimmed.match(OPEN_APP_PATTERN);
  if (openMatch) {
    return {
      path: "tool",
      action: { name: "open_app", target: extractTarget(openMatch[1]) },
      reason: "matched a known 'open <app>' action",
    };
  }

  const closeMatch = trimmed.match(CLOSE_APP_PATTERN);
  if (closeMatch) {
    return {
      path: "tool",
      action: { name: "close_app", target: extractTarget(closeMatch[1]) },
      reason: "matched a known 'close <app>' action",
    };
  }

  if (
    DEEP_PATTERN.test(trimmed) ||
    SEQUENTIAL_CLAUSE_PATTERN.test(trimmed) ||
    trimmed.length > DEEP_LENGTH_FLOOR
  ) {
    return { path: "deep", reason: "multi-step or thorough-analysis request" };
  }

  if (REASONING_PATTERN.test(trimmed) && trimmed.length >= REASONING_LENGTH_FLOOR) {
    return { path: "reasoning", reason: "comparison/judgment request" };
  }

  return { path: "fast", reason: "simple conversational request" };
}
