import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAuthorized, checkParsePolicySet } from '@cedar-policy/cedar-wasm/nodejs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const POLICY_FILE_PATH = path.resolve(__dirname, '../policies/agent.cedar');

export const STATIC_ENTITIES = [
  { uid: { type: 'Agent', id: 'support-bot' }, attrs: {}, parents: [] },
  { uid: { type: 'System', id: 'acme-prod' }, attrs: {}, parents: [] },
  ...[
    'read_customer',
    'search_customers',
    'read_tickets',
    'run_sql',
    'send_email',
    'export_customers',
    'issue_refund',
    'delete_customer'
  ].map(a => ({
    uid: { type: 'Action', id: a },
    attrs: {},
    parents: []
  }))
];

let activePolicyText = '';
let activePolicyIds = [];
let activePolicySet = null;

export function extractPolicyIds(text) {
  return [...text.matchAll(/@id\("([^"]+)"\)/g)].map(m => m[1]);
}

export function mapPolicyId(id, ids = activePolicyIds) {
  const match = /^policy(\d+)$/.exec(id);
  if (match) {
    const index = parseInt(match[1], 10);
    if (index >= 0 && index < ids.length) {
      return ids[index];
    }
  }
  return id;
}

export function getPolicyText() {
  return activePolicyText;
}

export function setPolicyText(text) {
  const parseResult = checkParsePolicySet({ staticPolicies: text });
  if (parseResult.type === 'failure') {
    const message = parseResult.errors?.map(e => e.message).join('; ') || 'Failed to parse Cedar policy';
    const error = new Error(message);
    error.errors = parseResult.errors;
    throw error;
  }

  activePolicyText = text;
  activePolicyIds = extractPolicyIds(text);
  activePolicySet = { staticPolicies: text };
  return activePolicyText;
}

export function resetPolicy() {
  const diskText = fs.readFileSync(POLICY_FILE_PATH, 'utf8');
  return setPolicyText(diskText);
}

export function check(actionId, context = {}) {
  const req = {
    principal: { type: 'Agent', id: 'support-bot' },
    action: { type: 'Action', id: actionId },
    resource: { type: 'System', id: 'acme-prod' },
    context: context || {},
    policies: activePolicySet,
    entities: STATIC_ENTITIES
  };

  const raw = isAuthorized(req);

  const rawReasons =
    raw.diagnostics?.reason ??
    raw.response?.diagnostics?.reason ??
    (Array.isArray(raw.reason) ? raw.reason : []);

  const reasons = rawReasons.map(r => mapPolicyId(r, activePolicyIds));

  const errors =
    raw.diagnostics?.errors ??
    raw.response?.diagnostics?.errors ??
    (raw.type === 'failure' && Array.isArray(raw.errors) ? raw.errors : []);

  const decision = raw.response?.decision ?? raw.decision ?? 'deny';
  const allowed = (String(decision).toLowerCase() === 'allow') && errors.length === 0;

  return {
    allowed,
    decision: String(decision),
    reasons,
    errors,
    raw
  };
}

// Initial policy loading at startup. Fails closed and crashes startup if invalid.
resetPolicy();
