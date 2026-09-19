import assert from 'node:assert/strict';
import { server, PORT } from '../src/server.js';
import { getPolicyText, resetPolicy } from '../src/cedar.js';
import { db } from '../src/db.js';

console.log('--- RUNNING END-TO-END DEMO & INTEGRATION VERIFICATION ---\n');

const baseUrl = `http://localhost:${PORT}`;

try {
  // =========================================================================
  // 1. Sequential Scenario Database Isolation
  // =========================================================================
  console.log('Integration Test 1: Verifying database isolation across sequential scenarios...');
  
  // Ensure starting with clean policy
  resetPolicy();

  // Run Happy Path
  const resHappy = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'happy' })
  });
  assert.equal(resHappy.status, 200);
  const dataHappy = await resHappy.json();
  assert.equal(dataHappy.trace.filter(t => t.kind === 'tool_call').length, 3);
  assert.equal(db.outbox.length, 1, 'Happy path must queue 1 email in outbox');
  assert.equal(db.outbox[0].to, 'priya@acme.example');

  // Run Catastrophe
  const resCatastrophe = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'catastrophe' })
  });
  assert.equal(resCatastrophe.status, 200);
  const dataCatastrophe = await resCatastrophe.json();
  assert.equal(dataCatastrophe.trace.filter(t => t.kind === 'tool_call').length, 3);
  // Database must have been reseeded: outbox empty, customer counts intact
  assert.equal(db.outbox.length, 0, 'Reseed must clear outbox before catastrophe');
  assert.equal(db.customers.length, 1247, 'Catastrophe must not delete customers');
  assert.equal(
    db.customers.filter(c => c.plan === 'test').length,
    312,
    'Catastrophe must leave all 312 test customers intact'
  );

  // Run Injection
  const resInjection = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'injection' })
  });
  assert.equal(resInjection.status, 200);
  const dataInjection = await resInjection.json();
  assert.equal(dataInjection.trace.filter(t => t.kind === 'tool_call').length, 3);
  assert.equal(db.outbox.length, 0, 'Injection must not queue email in outbox');
  assert.equal(db.customers.length, 1247, 'Injection must leave all 1247 customers intact');

  console.log('✓ Integration Test 1 Passed: In-memory DB reseeded cleanly across sequential runs (happy → catastrophe → injection)');

  // =========================================================================
  // 2. Demo Policy Edit & Multi-Rule Independence Verification
  // =========================================================================
  console.log('\nIntegration Test 2: Verifying demo policy edit (threshold 50 → 5000) and multi-rule independence...');

  // Step 2a: Run injection with default policy -> export denied (forbid-bulk-export) & email denied (forbid-email-to-untrusted-domain)
  const resInjBefore = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'injection' })
  });
  const dataInjBefore = await resInjBefore.json();
  const exportBefore = dataInjBefore.trace.find(t => t.tool === 'export_customers');
  const emailBefore = dataInjBefore.trace.find(t => t.tool === 'send_email');

  assert.equal(exportBefore.status, 'DENY');
  assert.deepEqual(exportBefore.reasons, ['forbid-bulk-export']);
  assert.equal(exportBefore.result, null);

  assert.equal(emailBefore.status, 'DENY');
  assert.deepEqual(emailBefore.reasons, ['forbid-email-to-untrusted-domain']);
  assert.equal(emailBefore.result, null);

  // Step 2b: Edit policy via POST /api/policy (change rowCount > 50 to rowCount > 5000)
  const originalPolicy = getPolicyText();
  const loosenedPolicy = originalPolicy.replace('context.rowCount > 50', 'context.rowCount > 5000');
  const resEdit = await fetch(`${baseUrl}/api/policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: loosenedPolicy })
  });
  assert.equal(resEdit.status, 200);

  // Step 2c: Re-run the SAME injection scenario -> export succeeds, email STILL blocked
  const resInjAfter = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'injection' })
  });
  const dataInjAfter = await resInjAfter.json();
  const exportAfter = dataInjAfter.trace.find(t => t.tool === 'export_customers');
  const emailAfter = dataInjAfter.trace.find(t => t.tool === 'send_email');

  assert.equal(exportAfter.status, 'ALLOW', 'Loosening export limit must permit export_customers');
  assert.deepEqual(exportAfter.reasons, ['allow-export']);
  assert.ok(exportAfter.result && exportAfter.result.rows === 1247, 'Export must execute and return 1247 rows');

  assert.equal(
    emailAfter.status,
    'DENY',
    'Email must remain strictly denied by independent policy (forbid-email-to-untrusted-domain)'
  );
  assert.deepEqual(emailAfter.reasons, ['forbid-email-to-untrusted-domain']);
  assert.equal(emailAfter.result, null);
  assert.equal(db.outbox.length, 0, 'Exfiltration email must never reach outbox');

  // Step 2d: Reset policy via POST /api/policy/reset
  const resReset = await fetch(`${baseUrl}/api/policy/reset`, {
    method: 'POST'
  });
  assert.equal(resReset.status, 200);
  const resetBody = await resReset.json();
  assert.ok(resetBody.text.includes('context.rowCount > 50'), 'Reset must restore threshold 50');

  // Step 2e: Re-run injection after reset -> export is denied again
  const resInjFinal = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'injection' })
  });
  const dataInjFinal = await resInjFinal.json();
  const exportFinal = dataInjFinal.trace.find(t => t.tool === 'export_customers');
  assert.equal(exportFinal.status, 'DENY', 'After reset, export must be denied again');
  assert.deepEqual(exportFinal.reasons, ['forbid-bulk-export']);

  console.log('✓ Integration Test 2 Passed: Policy edit beat (50 → 5000 → reset) demonstrates multi-rule independence flawlessly');

  // =========================================================================
  // 3. Complete Trace Contract Verification
  // =========================================================================
  console.log('\nIntegration Test 3: Verifying trace contract schemas across all tool calls and thoughts...');

  for (const scenario of ['happy', 'catastrophe', 'injection']) {
    const res = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario })
    });
    const { trace } = await res.json();
    assert.ok(Array.isArray(trace), `${scenario} trace must be array`);

    // Must end with done entry
    const lastEntry = trace[trace.length - 1];
    assert.equal(lastEntry.kind, 'done', `${scenario} last entry must be done`);

    // Verify thoughts
    const thoughts = trace.filter(t => t.kind === 'thought');
    for (const th of thoughts) {
      assert.equal(th.kind, 'thought');
      assert.equal(typeof th.text, 'string');
      assert.ok(th.text.length > 0);
      assert.equal(th.scripted, true);
    }

    // Verify tool calls
    const toolCalls = trace.filter(t => t.kind === 'tool_call');
    for (const tc of toolCalls) {
      assert.equal(tc.kind, 'tool_call');
      assert.equal(typeof tc.tool, 'string');
      assert.ok(tc.args && typeof tc.args === 'object');
      assert.ok(tc.context && typeof tc.context === 'object');
      assert.ok(['ALLOW', 'DENY', 'POLICY_ERROR', 'UNKNOWN_TOOL'].includes(tc.status));
      assert.equal(typeof tc.decision, 'string');
      assert.ok(Array.isArray(tc.reasons));
      assert.ok(Array.isArray(tc.errors));
      assert.equal(typeof tc.explanation, 'string');
      assert.ok('result' in tc);
    }
  }

  // Verify specific Catastrophe thought and default deny contract
  const resCat = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'catastrophe' })
  });
  const { trace: catTrace } = await resCat.json();
  const catThoughts = catTrace.filter(t => t.kind === 'thought');
  assert.equal(
    catThoughts[2].text,
    "The bulk delete didn't go through. I'll remove the test accounts one at a time instead."
  );
  const catToolCalls = catTrace.filter(t => t.kind === 'tool_call');
  const deleteCustCall = catToolCalls[2];
  assert.equal(deleteCustCall.tool, 'delete_customer');
  assert.equal(deleteCustCall.status, 'DENY');
  assert.deepEqual(deleteCustCall.reasons, [], 'Default deny must have reasons: []');
  assert.equal(deleteCustCall.result, null, 'Default deny must have result: null');

  console.log('✓ Integration Test 3 Passed: Trace schema conforms to specification; default deny contract verified');

  // =========================================================================
  // 4. API Error Handling & Failure States
  // =========================================================================
  console.log('\nIntegration Test 4: Verifying API failure states and error responses...');

  // Unknown scenario -> 400
  const resBadScenario = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'rogue_exploit' })
  });
  assert.equal(resBadScenario.status, 400);
  const badScenarioBody = await resBadScenario.json();
  assert.ok(badScenarioBody.error.includes('Unknown scenario'));

  // Invalid Cedar policy -> 400
  const resBadPolicy = await fetch(`${baseUrl}/api/policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'this is not valid cedar' })
  });
  assert.equal(resBadPolicy.status, 400);
  const badPolicyBody = await resBadPolicy.json();
  assert.ok(badPolicyBody.error);

  // Missing policy text -> 400
  const resMissingPolicy = await fetch(`${baseUrl}/api/policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(resMissingPolicy.status, 400);

  // Malformed JSON payload -> 400
  const resMalformed = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"scenario": invalid json}'
  });
  assert.equal(resMalformed.status, 400);
  const malformedBody = await resMalformed.json();
  assert.equal(malformedBody.error, 'Malformed JSON payload');

  console.log('✓ Integration Test 4 Passed: API failure states return appropriate HTTP 400 errors without crashing');

  // =========================================================================
  // 5. Deterministic Mock Brain Verification
  // =========================================================================
  console.log('\nIntegration Test 5: Verifying deterministic mock brain execution repeatability...');

  const run1 = await (await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'injection' })
  })).json();

  const run2 = await (await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'injection' })
  })).json();

  assert.deepEqual(run1.trace, run2.trace, 'Mock brain must produce identical traces for repeated runs');
  console.log('✓ Integration Test 5 Passed: Mock brain produces perfectly deterministic plans with zero drift');

  console.log('\n======================================================');
  console.log('ALL END-TO-END DEMO & INTEGRATION TESTS PASSED (5/5)!');
  console.log('======================================================\n');
} finally {
  if (server) {
    await new Promise(resolve => server.close(resolve));
    console.log('Server closed successfully.');
  }
}
