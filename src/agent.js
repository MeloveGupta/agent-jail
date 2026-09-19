import { check } from './cedar.js';
import { buildContext } from './context.js';
import { TOOLS, validateArgs } from './tools.js';
import { reseed } from './db.js';

export async function runAgent(scenarioId, brain) {
  reseed();

  const trace = [];
  const plan = await brain.plan(scenarioId);

  for (const step of plan) {
    trace.push({
      kind: 'thought',
      text: step.thought,
      scripted: true
    });

    if (!step.tool || !Object.hasOwn(TOOLS, step.tool)) {
      trace.push({
        kind: 'tool_call',
        tool: step.tool,
        args: step.args,
        context: {},
        status: 'UNKNOWN_TOOL',
        decision: 'n/a',
        reasons: [],
        errors: [],
        explanation: `No tool named "${step.tool}" is registered.`,
        result: null
      });

      continue;
    }

    let context = {};
    let verdict;

    try {
      context = buildContext(step.tool, step.args);
      verdict = check(step.tool, context);
    } catch (e) {
      verdict = {
        allowed: false,
        decision: 'PolicyError',
        reasons: [],
        errors: [String(e)]
      };
    }

    const engineErrors = verdict.errors ?? [];

    const policyBroke =
      engineErrors.length > 0 ||
      verdict.decision === 'PolicyError';

    const entry = {
      kind: 'tool_call',
      tool: step.tool,
      args: step.args,
      context,
      status: policyBroke
        ? 'POLICY_ERROR'
        : (verdict.allowed ? 'ALLOW' : 'DENY'),
      decision: verdict.decision,
      reasons: verdict.reasons ?? [],
      errors: engineErrors,
      explanation: '',
      result: null
    };

    if (entry.status === 'POLICY_ERROR') {
      entry.explanation =
        'Authorization engine error — action not executed (fail closed).';
    } else if (entry.status === 'DENY') {
      entry.explanation = entry.reasons.length
        ? `Blocked by policy: ${entry.reasons.join(', ')}`
        : 'Blocked by default deny — no policy permits this action.';
    } else {
      const invalid = validateArgs(step.tool, step.args);

      if (invalid) {
        entry.explanation =
          `Authorized, but arguments rejected: ${invalid}`;
        entry.result = {
          error: invalid
        };
      } else {
        entry.explanation = 'Authorized.';
        entry.result =
          await TOOLS[step.tool].run(step.args);
      }
    }

    trace.push(entry);
  }

  trace.push({
    kind: 'done'
  });

  return trace;
}
