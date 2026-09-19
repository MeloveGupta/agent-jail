import assert from 'node:assert/strict';
import { server, PORT } from '../src/server.js';
import { getPolicyText } from '../src/cedar.js';

console.log('--- RUNNING SERVER / API INTEGRATION VERIFICATION ---\n');

const baseUrl = `http://localhost:${PORT}`;

try {
  // 1. Verify server starts on port 3001
  console.log(`Test 1: Verifying server started on port ${PORT}...`);
  assert.ok(server && server.listening, 'Server must be listening');
  assert.equal(PORT, 3001, 'Default port must be 3001');
  console.log(`✓ Test 1 Passed: Server listening on port ${PORT}`);

  // 2. GET /api/policy returns active policy text
  console.log('\nTest 2: Verifying GET /api/policy...');
  const resGetPolicy = await fetch(`${baseUrl}/api/policy`);
  assert.equal(resGetPolicy.status, 200, 'GET /api/policy must return 200');
  const bodyGetPolicy = await resGetPolicy.json();
  assert.ok(typeof bodyGetPolicy.text === 'string' && bodyGetPolicy.text.length > 0);
  assert.equal(bodyGetPolicy.text, getPolicyText());
  console.log('✓ Test 2 Passed: GET /api/policy returns active policy text');

  // 3. POST /api/policy accepts valid Cedar
  console.log('\nTest 3: Verifying POST /api/policy accepts valid Cedar...');
  const diskPolicy = getPolicyText();
  const modifiedValidPolicy = diskPolicy.replace('context.rowCount > 50', 'context.rowCount > 5000');
  const resPostValid = await fetch(`${baseUrl}/api/policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: modifiedValidPolicy })
  });
  assert.equal(resPostValid.status, 200, 'POST /api/policy with valid Cedar must return 200');
  const bodyPostValid = await resPostValid.json();
  assert.ok(bodyPostValid.text.includes('context.rowCount > 5000'));
  console.log('✓ Test 3 Passed: POST /api/policy accepts valid Cedar and updates active policy');

  // 4. POST /api/policy rejects invalid Cedar with HTTP 400
  console.log('\nTest 4: Verifying POST /api/policy rejects invalid Cedar with HTTP 400...');
  const resPostInvalid = await fetch(`${baseUrl}/api/policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'INVALID SYNTAX !!! NOT A POLICY' })
  });
  assert.equal(resPostInvalid.status, 400, 'POST /api/policy with invalid Cedar must return 400');
  const bodyPostInvalid = await resPostInvalid.json();
  assert.ok(bodyPostInvalid.error, 'Must contain error message');
  console.log(`✓ Test 4 Passed: Rejected invalid Cedar with 400 (error: "${bodyPostInvalid.error.slice(0, 40)}...")`);

  // 5. Invalid policy leaves previous active policy unchanged
  console.log('\nTest 5: Verifying invalid policy leaves active policy unchanged...');
  const resCheckAfterInvalid = await fetch(`${baseUrl}/api/policy`);
  const bodyCheckAfterInvalid = await resCheckAfterInvalid.json();
  assert.ok(
    bodyCheckAfterInvalid.text.includes('context.rowCount > 5000'),
    'Active policy must retain previous valid state'
  );
  console.log('✓ Test 5 Passed: Active policy remained untouched after parse error');

  // 6. POST /api/policy/reset restores disk policy
  console.log('\nTest 6: Verifying POST /api/policy/reset restores disk policy...');
  const resReset = await fetch(`${baseUrl}/api/policy/reset`, {
    method: 'POST'
  });
  assert.equal(resReset.status, 200, 'POST /api/policy/reset must return 200');
  const bodyReset = await resReset.json();
  assert.ok(bodyReset.text.includes('context.rowCount > 50'));
  assert.ok(!bodyReset.text.includes('context.rowCount > 5000'));
  console.log('✓ Test 6 Passed: POST /api/policy/reset restored on-disk policy');

  // 7 & 8. POST /api/run with happy returns HTTP 200 and three ALLOW tool calls
  console.log('\nTest 7 & 8: Verifying POST /api/run with scenario "happy"...');
  const resRunHappy = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'happy' })
  });
  assert.equal(resRunHappy.status, 200, 'POST /api/run (happy) must return 200');
  const bodyRunHappy = await resRunHappy.json();
  assert.ok(Array.isArray(bodyRunHappy.trace), 'Response must contain trace array');
  const happyToolCalls = bodyRunHappy.trace.filter(t => t.kind === 'tool_call');
  assert.equal(happyToolCalls.length, 3);
  assert.deepEqual(
    happyToolCalls.map(t => ({ tool: t.tool, status: t.status })),
    [
      { tool: 'search_customers', status: 'ALLOW' },
      { tool: 'read_customer', status: 'ALLOW' },
      { tool: 'send_email', status: 'ALLOW' }
    ]
  );
  assert.equal(bodyRunHappy.trace[bodyRunHappy.trace.length - 1].kind, 'done');
  console.log('✓ Tests 7 & 8 Passed: happy returned HTTP 200 with 3 ALLOW tool calls');

  // 9 & 10. POST /api/run with catastrophe returns HTTP 200 and ALLOW -> DENY -> DENY
  console.log('\nTest 9 & 10: Verifying POST /api/run with scenario "catastrophe"...');
  const resRunCatastrophe = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'catastrophe' })
  });
  assert.equal(resRunCatastrophe.status, 200, 'POST /api/run (catastrophe) must return 200');
  const bodyRunCatastrophe = await resRunCatastrophe.json();
  const catastropheToolCalls = bodyRunCatastrophe.trace.filter(t => t.kind === 'tool_call');
  assert.equal(catastropheToolCalls.length, 3);
  assert.deepEqual(
    catastropheToolCalls.map(t => ({ tool: t.tool, status: t.status })),
    [
      { tool: 'run_sql', status: 'ALLOW' },
      { tool: 'run_sql', status: 'DENY' },
      { tool: 'delete_customer', status: 'DENY' }
    ]
  );
  assert.deepEqual(catastropheToolCalls[1].reasons, ['forbid-destructive-sql']);
  assert.deepEqual(catastropheToolCalls[2].reasons, [], 'delete_customer has empty reasons (default deny)');
  console.log('✓ Tests 9 & 10 Passed: catastrophe returned HTTP 200 with ALLOW -> DENY -> DENY');

  // 11 & 12. POST /api/run with injection returns HTTP 200 and ALLOW -> DENY -> DENY
  console.log('\nTest 11 & 12: Verifying POST /api/run with scenario "injection"...');
  const resRunInjection = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'injection' })
  });
  assert.equal(resRunInjection.status, 200, 'POST /api/run (injection) must return 200');
  const bodyRunInjection = await resRunInjection.json();
  const injectionToolCalls = bodyRunInjection.trace.filter(t => t.kind === 'tool_call');
  assert.equal(injectionToolCalls.length, 3);
  assert.deepEqual(
    injectionToolCalls.map(t => ({ tool: t.tool, status: t.status })),
    [
      { tool: 'read_tickets', status: 'ALLOW' },
      { tool: 'export_customers', status: 'DENY' },
      { tool: 'send_email', status: 'DENY' }
    ]
  );
  assert.deepEqual(injectionToolCalls[1].reasons, ['forbid-bulk-export']);
  assert.deepEqual(injectionToolCalls[2].reasons, ['forbid-email-to-untrusted-domain']);
  console.log('✓ Tests 11 & 12 Passed: injection returned HTTP 200 with ALLOW -> DENY -> DENY');

  // 13. Unknown scenario returns HTTP 400
  console.log('\nTest 13: Verifying unknown and missing scenario returns HTTP 400...');
  const resUnknown = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'unsupported_scenario' })
  });
  assert.equal(resUnknown.status, 400);
  const bodyUnknown = await resUnknown.json();
  assert.ok(bodyUnknown.error.includes('unsupported_scenario'));

  const resMissing = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(resMissing.status, 400);
  console.log('✓ Test 13 Passed: Unknown/missing scenario returned HTTP 400');

  // 14. DENY does not become an HTTP error
  console.log('\nTest 14: Verifying DENY does not become an HTTP error...');
  assert.equal(resRunCatastrophe.status, 200, 'Catastrophe with denials must still return HTTP 200');
  assert.equal(resRunInjection.status, 200, 'Injection with denials must still return HTTP 200');
  console.log('✓ Test 14 Passed: Denials returned HTTP 200 with trace populated');

  // 15. POLICY_ERROR remains represented inside the trace rather than becoming an HTTP failure
  console.log('\nTest 15: Verifying POLICY_ERROR remains inside trace without causing HTTP failure...');
  // Set broken policy where context evaluation fails
  await fetch(`${baseUrl}/api/policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `@id("eval-fail") permit (principal, action == Action::"read_tickets", resource) when { context.nonExistentField > 0 };`
    })
  });
  const resRunError = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'injection' })
  });
  assert.equal(resRunError.status, 200, 'POLICY_ERROR must not cause HTTP error');
  const bodyRunError = await resRunError.json();
  const errorStep = bodyRunError.trace.find(t => t.kind === 'tool_call' && t.tool === 'read_tickets');
  assert.equal(errorStep.status, 'POLICY_ERROR');
  assert.equal(errorStep.explanation, 'Authorization engine error — action not executed (fail closed).');
  // Reset policy
  await fetch(`${baseUrl}/api/policy/reset`, { method: 'POST' });
  console.log('✓ Test 15 Passed: POLICY_ERROR represented cleanly in trace and returned with HTTP 200');

  // 16. GET /api/policy reflects an edited active policy
  console.log('\nTest 16: Verifying GET /api/policy reflects active edits...');
  await fetch(`${baseUrl}/api/policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: modifiedValidPolicy })
  });
  const resGetEdited = await fetch(`${baseUrl}/api/policy`);
  const bodyGetEdited = await resGetEdited.json();
  assert.ok(bodyGetEdited.text.includes('context.rowCount > 5000'));
  console.log('✓ Test 16 Passed: GET /api/policy reflects edited policy');

  // 17. POST /api/policy/reset restores original policy
  console.log('\nTest 17: Verifying POST /api/policy/reset restores original policy...');
  await fetch(`${baseUrl}/api/policy/reset`, { method: 'POST' });
  const resGetFinal = await fetch(`${baseUrl}/api/policy`);
  const bodyGetFinal = await resGetFinal.json();
  assert.ok(bodyGetFinal.text.includes('context.rowCount > 50'));
  assert.ok(!bodyGetFinal.text.includes('context.rowCount > 5000'));
  console.log('✓ Test 17 Passed: POST /api/policy/reset restored on-disk policy');

  console.log('\n======================================================');
  console.log('ALL SERVER / API INTEGRATION TESTS PASSED (17/17)!');
  console.log('======================================================\n');
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    console.log('Server closed successfully.');
  }
}
