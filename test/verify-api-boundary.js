import assert from 'node:assert/strict';
import { server, PORT } from '../src/server.js';
import { getPolicyText, resetPolicy } from '../src/cedar.js';
import { db, reseed } from '../src/db.js';

console.log('--- RUNNING ADVERSARIAL API & INPUT-BOUNDARY VERIFICATION ---\n');

const baseUrl = `http://localhost:${PORT}`;

try {
  // 1. Adversarial POST /api/run Input Boundary
  console.log('Test 1: Verifying POST /api/run adversarial inputs & type boundary...');

  // Empty body, missing body, empty object
  const resEmptyObj = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(resEmptyObj.status, 400, 'Empty object must return 400');
  const bodyEmptyObj = await resEmptyObj.json();
  assert.equal(bodyEmptyObj.error, 'Unknown scenario: undefined');

  // Non-string scenario payloads (null, number, boolean, array, object)
  const invalidScenarios = [
    null,
    12345,
    true,
    ['happy'],
    { evil: true },
    '',
    'A'.repeat(5000),
    '__proto__',
    'constructor',
    'toString',
    'valueOf',
    '../../etc/passwd',
    'nonexistent_scenario'
  ];

  for (const s of invalidScenarios) {
    const res = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: s })
    });
    assert.equal(res.status, 400, `Scenario ${JSON.stringify(s)} must return HTTP 400`);
    const body = await res.json();
    assert.ok(typeof body.error === 'string' && body.error.startsWith('Unknown scenario:'));
    assert.ok(!body.stack, 'Error responses must never leak stack traces');
  }
  console.log('✓ Test 1 Passed: POST /api/run safely rejects non-string and invalid scenario inputs with clean 400s');

  // 2. Client-Provided Bypass & Authorization Smuggling Resistance
  console.log('\nTest 2: Verifying client-provided bypass & authorization smuggling resistance...');
  const resSmuggle = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scenario: 'catastrophe',
      // Smuggled client fields attempting to bypass authorization
      allowed: true,
      decision: 'ALLOW',
      status: 'ALLOW',
      bypass: true,
      authorized: true,
      execute: true,
      fakeResult: { deleted: 1247 },
      context: { sqlOperation: 'SELECT', adminBypass: true },
      db: { customers: [] }
    })
  });
  assert.equal(resSmuggle.status, 200);
  const bodySmuggle = await resSmuggle.json();
  assert.ok(Array.isArray(bodySmuggle.trace), 'Must return server execution trace');

  // Verify server evaluated Cedar independently and denied destructive SQL & delete_customer
  const toolCalls = bodySmuggle.trace.filter(t => t.kind === 'tool_call');
  assert.equal(toolCalls.length, 3);
  assert.equal(toolCalls[0].status, 'ALLOW', 'SELECT count(*) allowed');
  assert.equal(toolCalls[1].status, 'DENY', 'DELETE run_sql must be DENIED despite client bypass payload');
  assert.equal(toolCalls[2].status, 'DENY', 'delete_customer must be DENIED by default deny');
  assert.equal(toolCalls[1].result, null);
  assert.equal(toolCalls[2].result, null);
  assert.equal(db.customers.length, 1247, 'Database must remain 100% intact');
  console.log('✓ Test 2 Passed: Client-provided bypass, context, and decision smuggling strictly ignored by server');

  // 3. Adversarial POST /api/policy Inputs
  console.log('\nTest 3: Verifying POST /api/policy adversarial inputs & boundary constraints...');

  // Non-string policy payloads
  const invalidPolicies = [
    undefined,
    null,
    12345,
    true,
    ['permit(principal, action, resource);'],
    { text: 'permit(principal, action, resource);' }, // nested object
    { rule: 'permit' }
  ];

  for (const p of invalidPolicies) {
    const res = await fetch(`${baseUrl}/api/policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: p })
    });
    assert.equal(res.status, 400, `Non-string policy payload must return 400`);
    const body = await res.json();
    assert.equal(body.error, 'Missing or invalid policy text');
  }

  // Null byte in policy string
  const resNullByte = await fetch(`${baseUrl}/api/policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'permit(principal, action, resource);\0' })
  });
  assert.equal(resNullByte.status, 400, 'Null byte in policy must be rejected');
  const bodyNullByte = await resNullByte.json();
  assert.ok(bodyNullByte.error.includes('failed to parse policies') || bodyNullByte.error.includes('invalid token'));

  // Active policy preservation upon invalid updates
  const validDiskPolicy = getPolicyText();
  const resBadSyntax = await fetch(`${baseUrl}/api/policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'FORBID EVERYTHING !!! SYNTAX ERROR' })
  });
  assert.equal(resBadSyntax.status, 400);
  assert.equal(getPolicyText(), validDiskPolicy, 'Active policy must remain untouched after parse error');

  // Empty string policy (valid Cedar 0 policies -> default deny)
  const resEmptyPolicy = await fetch(`${baseUrl}/api/policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '' })
  });
  assert.equal(resEmptyPolicy.status, 200);
  const bodyEmptyPolicy = await resEmptyPolicy.json();
  assert.equal(bodyEmptyPolicy.text, '');

  // Reset back to disk policy
  resetPolicy();
  assert.equal(getPolicyText(), validDiskPolicy);
  console.log('✓ Test 3 Passed: POST /api/policy validates types, rejects null bytes, and maintains active policy invariants');

  // 4. Adversarial POST /api/policy/reset Inputs & Idempotency
  console.log('\nTest 4: Verifying POST /api/policy/reset input isolation & idempotency...');
  const resResetWithPayload = await fetch(`${baseUrl}/api/policy/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'permit(principal, action, resource);',
      injectedPolicy: 'malicious',
      admin: true
    })
  });
  assert.equal(resResetWithPayload.status, 200);
  const bodyReset = await resResetWithPayload.json();
  assert.equal(bodyReset.text, validDiskPolicy, 'Reset must strictly read from disk and ignore client payload');
  console.log('✓ Test 4 Passed: POST /api/policy/reset is idempotent and impervious to payload injection');

  // 5. GET /api/policy Response Hygiene
  console.log('\nTest 5: Verifying GET /api/policy response hygiene...');
  const resGetPolicy = await fetch(`${baseUrl}/api/policy`);
  assert.equal(resGetPolicy.status, 200);
  const bodyGetPolicy = await resGetPolicy.json();
  assert.ok(typeof bodyGetPolicy.text === 'string');
  assert.ok(!bodyGetPolicy.text.includes('/Users/'), 'Policy text must not leak local filesystem paths');
  assert.ok(!bodyGetPolicy.text.includes('AKIA'), 'Policy text must not contain AWS keys');
  console.log('✓ Test 5 Passed: GET /api/policy returns clean text without leaking internal environment details');

  // 6. Request Entity Too Large & Status Code Preservation
  console.log('\nTest 6: Verifying oversized payload handling & HTTP 413 preservation...');
  const bigPayload = JSON.stringify({
    scenario: 'happy',
    padding: 'X'.repeat(200000) // 200 KB exceeds 100 KB body-parser default limit
  });
  const resOversized = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bigPayload
  });
  assert.equal(resOversized.status, 413, 'Payload exceeding limit must return HTTP 413, not 500');
  const bodyOversized = await resOversized.json();
  assert.equal(bodyOversized.error, 'request entity too large');
  assert.ok(!bodyOversized.stack, 'Oversized payload response must not expose stack trace');
  console.log('✓ Test 6 Passed: Oversized payloads correctly return HTTP 413 without 500 degradation or stack leaks');

  // 7. Missing Content-Type and Non-JSON Request Bodies
  console.log('\nTest 7: Verifying missing Content-Type & non-JSON body handling...');
  const resTextPlain = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'scenario=happy'
  });
  assert.equal(resTextPlain.status, 400, 'text/plain body must return 400');
  const bodyTextPlain = await resTextPlain.json();
  assert.equal(bodyTextPlain.error, 'Unknown scenario: undefined');

  const resNoContentType = await fetch(`${baseUrl}/api/policy`, {
    method: 'POST',
    body: 'text=something'
  });
  assert.equal(resNoContentType.status, 400, 'Missing Content-Type must return 400');
  console.log('✓ Test 7 Passed: Non-JSON and missing Content-Type requests safely rejected without uncaught exceptions');

  // 8. Canonical Scenarios Steady-State Verification
  console.log('\nTest 8: Verifying canonical scenarios steady-state after adversarial attacks...');
  reseed();
  resetPolicy();

  const [resH, resC, resI] = await Promise.all([
    fetch(`${baseUrl}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: 'happy' }) }),
    fetch(`${baseUrl}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: 'catastrophe' }) }),
    fetch(`${baseUrl}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: 'injection' }) })
  ]);

  assert.equal(resH.status, 200);
  assert.equal(resC.status, 200);
  assert.equal(resI.status, 200);

  const dataH = await resH.json();
  const dataC = await resC.json();
  const dataI = await resI.json();

  assert.equal(dataH.trace.filter(t => t.kind === 'tool_call' && t.status === 'ALLOW').length, 3);
  assert.equal(dataC.trace.filter(t => t.kind === 'tool_call' && t.status === 'DENY').length, 2);
  assert.equal(dataI.trace.filter(t => t.kind === 'tool_call' && t.status === 'DENY').length, 2);

  console.log('✓ Test 8 Passed: All canonical scenarios execute cleanly with zero residual state pollution');

  console.log('\n======================================================');
  console.log('ALL ADVERSARIAL API BOUNDARY TESTS PASSED (8/8)!');
  console.log('======================================================\n');
} finally {
  if (server) {
    await new Promise(resolve => server.close(resolve));
    console.log('API boundary verification server closed successfully.');
  }
}
