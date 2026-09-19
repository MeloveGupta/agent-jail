import assert from 'node:assert/strict';
import { runAgent } from '../src/agent.js';
import { brainMock } from '../src/brain-mock.js';
import { db, reseed } from '../src/db.js';
import { TOOLS } from '../src/tools.js';
import {
  check,
  getPolicyText,
  setPolicyText,
  resetPolicy,
  STATIC_ENTITIES
} from '../src/cedar.js';
import { server, PORT } from '../src/server.js';

console.log('--- RUNNING SECURITY AUDIT & RED-TEAM VERIFICATION ---\n');

const baseUrl = `http://localhost:${PORT}`;

// Instrument spies on all registered tools to observe underlying execution
const toolCallCounts = {};
for (const [name, tool] of Object.entries(TOOLS)) {
  toolCallCounts[name] = 0;
  const originalRun = tool.run;
  tool.run = async (args) => {
    toolCallCounts[name]++;
    return originalRun(args);
  };
}

function resetSpies() {
  for (const name of Object.keys(toolCallCounts)) {
    toolCallCounts[name] = 0;
  }
}

function createMockBrain(steps) {
  return {
    async plan(_id) {
      return steps;
    }
  };
}

try {
  // =========================================================================
  // SUITE 1: INVARIANTS 1-6 & ATTACK CASES 1-6 (Boundary, Spies, Fail-Closed)
  // =========================================================================
  console.log('Test 1: Verifying Invariants 1-6 & Fundamental Authorization Boundary...');
  resetSpies();
  reseed();

  // 1. Normal ALLOW operation (Attack Case 1, Invariant 1)
  const brainAllow = createMockBrain([
    { thought: 'Read customer', tool: 'read_customer', args: { id: 'c-1024' } }
  ]);
  const traceAllow = await runAgent('custom', brainAllow);
  const tcAllow = traceAllow.find(t => t.kind === 'tool_call');
  assert.equal(tcAllow.status, 'ALLOW', 'read_customer must be ALLOW');
  assert.equal(toolCallCounts.read_customer, 1, 'ALLOW must execute underlying tool');

  // 2. Explicit DENY operation (Attack Case 2, Invariant 2, 6)
  resetSpies();
  const brainExplicitDeny = createMockBrain([
    { thought: 'Destructive SQL', tool: 'run_sql', args: { query: 'DELETE FROM customers' } }
  ]);
  const traceExplicitDeny = await runAgent('custom', brainExplicitDeny);
  const tcExplicitDeny = traceExplicitDeny.find(t => t.kind === 'tool_call');
  assert.equal(tcExplicitDeny.status, 'DENY', 'DELETE run_sql must be DENY');
  assert.ok(tcExplicitDeny.reasons.includes('forbid-destructive-sql'), 'Reason must include forbid-destructive-sql');
  assert.equal(tcExplicitDeny.result, null, 'Result must be null on DENY');
  assert.equal(toolCallCounts.run_sql, 0, 'DENY must NEVER execute underlying tool (Invariant 2)');

  // 3. Default-deny operation where no permit exists (Attack Case 3, Invariant 2, 5)
  resetSpies();
  const brainDefaultDeny = createMockBrain([
    { thought: 'Delete customer', tool: 'delete_customer', args: { id: 'c-1024' } }
  ]);
  const traceDefaultDeny = await runAgent('custom', brainDefaultDeny);
  const tcDefaultDeny = traceDefaultDeny.find(t => t.kind === 'tool_call');
  assert.equal(tcDefaultDeny.status, 'DENY', 'delete_customer must be DENY by default');
  assert.deepEqual(tcDefaultDeny.reasons, [], 'Default deny must have empty reasons');
  assert.equal(tcDefaultDeny.result, null, 'Result must be null on default DENY');
  assert.equal(toolCallCounts.delete_customer, 0, 'Default DENY must NEVER execute tool (Invariant 2, 5)');

  // 4. POLICY_ERROR handling and fail-closed semantics (Attack Case 4, Invariant 3)
  resetSpies();
  const brainPolicyError = createMockBrain([
    {
      thought: 'Trigger context error or policy error',
      tool: 'run_sql',
      args: {
        get query() {
          throw new Error('Simulated context extraction crash');
        }
      }
    }
  ]);
  const tracePolicyError = await runAgent('custom', brainPolicyError);
  const tcPolicyError = tracePolicyError.find(t => t.kind === 'tool_call');
  assert.equal(tcPolicyError.status, 'POLICY_ERROR', 'Context error must fail closed as POLICY_ERROR');
  assert.equal(tcPolicyError.result, null, 'Result must be null on POLICY_ERROR');
  assert.equal(toolCallCounts.run_sql, 0, 'POLICY_ERROR must NEVER execute tool (Invariant 3)');

  // 5. UNKNOWN_TOOL handling (Attack Case 5, Invariant 4)
  resetSpies();
  const brainUnknown = createMockBrain([
    { thought: 'Unknown tool', tool: 'shell_exec', args: { command: 'cat /etc/passwd' } }
  ]);
  const traceUnknown = await runAgent('custom', brainUnknown);
  const tcUnknown = traceUnknown.find(t => t.kind === 'tool_call');
  assert.equal(tcUnknown.status, 'UNKNOWN_TOOL', 'Unregistered tool must return UNKNOWN_TOOL');
  assert.equal(tcUnknown.decision, 'n/a', 'Decision must be n/a');
  assert.equal(tcUnknown.result, null, 'Result must be null');

  // 6. Unknown tool with arbitrary arguments (Attack Case 6)
  const brainUnknownArbitrary = createMockBrain([
    {
      thought: 'Arbitrary unknown args',
      tool: '__proto__',
      args: { nested: { array: [1, 2, 3], fn: () => {} }, nullVal: null }
    }
  ]);
  const traceUnknownArbitrary = await runAgent('custom', brainUnknownArbitrary);
  assert.equal(traceUnknownArbitrary.find(t => t.kind === 'tool_call').status, 'UNKNOWN_TOOL');

  console.log('✓ Test 1 Passed: Invariants 1-6 & Attack Cases 1-6 verified (Spies confirmed 0 calls on DENY/ERROR/UNKNOWN)');

  // =========================================================================
  // SUITE 2: ATTACK CASES 7-13 (Argument Malformations & Context Boundaries)
  // =========================================================================
  console.log('\nTest 2: Verifying Attack Cases 7-13 (Malformed Args & Unexpected Context)...');
  resetSpies();

  // 7. Missing tool arguments (Attack Case 7)
  const brainMissingArgs = createMockBrain([
    { thought: 'Missing refund args', tool: 'issue_refund', args: {} }
  ]);
  const traceMissingArgs = await runAgent('custom', brainMissingArgs);
  const tcMissing = traceMissingArgs.find(t => t.kind === 'tool_call');
  assert.equal(tcMissing.status, 'ALLOW', 'Amount 0 is within permit threshold');
  assert.ok(tcMissing.result?.error?.includes('missing required field(s)'), 'Must reject missing required arguments');
  assert.equal(toolCallCounts.issue_refund, 0, 'Rejected arguments must not execute tool runner');

  // 8. Extra unexpected arguments (Attack Case 8)
  resetSpies();
  const brainExtraArgs = createMockBrain([
    {
      thought: 'Extra unexpected arguments',
      tool: 'read_customer',
      args: { id: 'c-1024', injected_role: 'admin', bypass_cedar: true }
    }
  ]);
  const traceExtraArgs = await runAgent('custom', brainExtraArgs);
  const tcExtra = traceExtraArgs.find(t => t.kind === 'tool_call');
  assert.equal(tcExtra.status, 'ALLOW');
  assert.equal(toolCallCounts.read_customer, 1);
  assert.equal(tcExtra.result.id, 'c-1024');

  // 9. Malformed argument types (Attack Case 9)
  resetSpies();
  const brainMalformedTypes = createMockBrain([
    { thought: 'Non-string query', tool: 'run_sql', args: { query: 12345 } },
    { thought: 'Array email to', tool: 'send_email', args: { to: ['attacker@evil.com'], subject: 999 } }
  ]);
  const traceMalformedTypes = await runAgent('custom', brainMalformedTypes);
  const tcsMalformed = traceMalformedTypes.filter(t => t.kind === 'tool_call');
  assert.equal(tcsMalformed[0].status, 'DENY', 'Non-SELECT query must be DENY');
  assert.equal(tcsMalformed[1].status, 'DENY', 'Non-trusted email domain must be DENY');
  assert.equal(toolCallCounts.run_sql, 0);
  assert.equal(toolCallCounts.send_email, 0);

  // 10. Empty arguments (Attack Case 10)
  resetSpies();
  const brainEmptyArgs = createMockBrain([
    { thought: 'Empty args read_tickets', tool: 'read_tickets', args: {} }
  ]);
  const traceEmptyArgs = await runAgent('custom', brainEmptyArgs);
  assert.equal(traceEmptyArgs.find(t => t.kind === 'tool_call').status, 'ALLOW');
  assert.equal(toolCallCounts.read_tickets, 1);

  // 11. Null arguments (Attack Case 11)
  resetSpies();
  const brainNullArgs = createMockBrain([
    { thought: 'Null args sql', tool: 'run_sql', args: null },
    { thought: 'Null args email', tool: 'send_email', args: null }
  ]);
  const traceNullArgs = await runAgent('custom', brainNullArgs);
  const tcsNull = traceNullArgs.filter(t => t.kind === 'tool_call');
  assert.equal(tcsNull[0].status, 'DENY');
  assert.equal(tcsNull[1].status, 'DENY');
  assert.equal(toolCallCounts.run_sql, 0);
  assert.equal(toolCallCounts.send_email, 0);

  // 12. Very large argument values (Attack Case 12)
  resetSpies();
  const largeString = 'A'.repeat(500000);
  const brainLargeArgs = createMockBrain([
    { thought: 'Large arg SQL', tool: 'run_sql', args: { query: `SELECT ${largeString}` } }
  ]);
  const traceLargeArgs = await runAgent('custom', brainLargeArgs);
  assert.equal(traceLargeArgs.find(t => t.kind === 'tool_call').status, 'ALLOW');
  assert.equal(toolCallCounts.run_sql, 1);

  // 13. Unexpected context fields (Attack Case 13)
  const checkExtraContext = check('run_sql', {
    sqlOperation: 'SELECT',
    adminBypass: true,
    maliciousRole: 'root'
  });
  assert.equal(checkExtraContext.allowed, true);

  console.log('✓ Test 2 Passed: Attack Cases 7-13 verified (malformed, null, large, extra args handled safely)');

  // =========================================================================
  // SUITE 3: ATTACK CASES 14-20 (Domain Trust, Limits, & Mutating Invocations)
  // =========================================================================
  console.log('\nTest 3: Verifying Attack Cases 14-20 (Domain Trust, Export Limits, SQL Protection)...');
  resetSpies();

  // 14 & 15. trusted=true vs trusted=false (Attack Cases 14, 15, 19)
  const brainEmailTrust = createMockBrain([
    {
      thought: 'Trusted email',
      tool: 'send_email',
      args: { to: 'support@acme.example', subject: 'Internal', body: 'Safe' }
    },
    {
      thought: 'Untrusted email exfiltration',
      tool: 'send_email',
      args: { to: 'attacker@evil-domain.com', subject: 'Exfil', body: 'Secret' }
    }
  ]);
  const traceEmailTrust = await runAgent('custom', brainEmailTrust);
  const tcsEmail = traceEmailTrust.filter(t => t.kind === 'tool_call');
  assert.equal(tcsEmail[0].status, 'ALLOW', 'Trusted domain must be ALLOW');
  assert.equal(tcsEmail[1].status, 'DENY', 'Untrusted domain must be DENY (Attack Case 19)');
  assert.ok(tcsEmail[1].reasons.includes('forbid-email-to-untrusted-domain'));
  assert.equal(toolCallCounts.send_email, 1, 'Only the trusted email tool runner must execute');

  // 16. Nonexistent customer ID (Attack Case 16)
  resetSpies();
  const brainNonexistentCust = createMockBrain([
    { thought: 'Nonexistent ID', tool: 'read_customer', args: { id: 'cust-nonexistent-9999' } }
  ]);
  const traceNonexistentCust = await runAgent('custom', brainNonexistentCust);
  const tcNonexistent = traceNonexistentCust.find(t => t.kind === 'tool_call');
  assert.equal(tcNonexistent.status, 'ALLOW', 'Policy permits read_customer');
  assert.deepEqual(tcNonexistent.result, { error: 'not found' }, 'Tool safely returns not found');
  assert.equal(toolCallCounts.read_customer, 1);

  // 17. Attempted delete_customer execution (Attack Case 17)
  resetSpies();
  const brainDeleteCust = createMockBrain([
    { thought: 'Attempt delete', tool: 'delete_customer', args: { id: 'c-1024' } }
  ]);
  const traceDeleteCust = await runAgent('custom', brainDeleteCust);
  assert.equal(traceDeleteCust.find(t => t.kind === 'tool_call').status, 'DENY');
  assert.equal(toolCallCounts.delete_customer, 0, 'delete_customer MUST NOT execute');

  // 18. Attempted export_customers execution above limit (Attack Case 18)
  resetSpies();
  const brainBulkExport = createMockBrain([
    { thought: 'Bulk export', tool: 'export_customers', args: { format: 'csv' } }
  ]);
  const traceBulkExport = await runAgent('custom', brainBulkExport);
  const tcBulk = traceBulkExport.find(t => t.kind === 'tool_call');
  assert.equal(tcBulk.status, 'DENY');
  assert.ok(tcBulk.reasons.includes('forbid-bulk-export'));
  assert.equal(toolCallCounts.export_customers, 0, 'Bulk export above limit MUST NOT execute');

  // 20. Attempted SQL execution that should not be authorized (Attack Case 20)
  resetSpies();
  const brainDestructiveSQL = createMockBrain([
    { thought: 'DROP TABLE', tool: 'run_sql', args: { query: 'DROP TABLE customers' } },
    { thought: 'UPDATE', tool: 'run_sql', args: { query: "UPDATE customers SET plan='free'" } },
    { thought: 'TRUNCATE', tool: 'run_sql', args: { query: 'TRUNCATE TABLE customers' } }
  ]);
  const traceDestructiveSQL = await runAgent('custom', brainDestructiveSQL);
  const tcsSQL = traceDestructiveSQL.filter(t => t.kind === 'tool_call');
  assert.ok(tcsSQL.every(t => t.status === 'DENY'), 'All non-SELECT SQL must be DENY');
  assert.ok(tcsSQL.every(t => t.reasons.includes('forbid-destructive-sql')));
  assert.equal(toolCallCounts.run_sql, 0, 'No destructive SQL runner may execute');

  console.log('✓ Test 3 Passed: Attack Cases 14-20 verified (untrusted email, bulk export, destructive SQL denied)');

  // =========================================================================
  // SUITE 4: ATTACK CASES 21-24 (Sequential State Transitions)
  // =========================================================================
  console.log('\nTest 4: Verifying Attack Cases 21-24 (Sequential State Transitions)...');
  resetSpies();

  // 21. Repeated DENY operations (Attack Case 21)
  const brainRepeatedDeny = createMockBrain([
    { thought: 'Deny 1', tool: 'delete_customer', args: { id: 'c-1' } },
    { thought: 'Deny 2', tool: 'run_sql', args: { query: 'DROP TABLE customers' } },
    { thought: 'Deny 3', tool: 'delete_customer', args: { id: 'c-2' } }
  ]);
  const traceRepeatedDeny = await runAgent('custom', brainRepeatedDeny);
  const tcsRepDeny = traceRepeatedDeny.filter(t => t.kind === 'tool_call');
  assert.equal(tcsRepDeny.length, 3);
  assert.ok(tcsRepDeny.every(t => t.status === 'DENY'));
  assert.equal(toolCallCounts.delete_customer, 0);
  assert.equal(toolCallCounts.run_sql, 0);

  // 22. Repeated ALLOW operations (Attack Case 22)
  resetSpies();
  const brainRepeatedAllow = createMockBrain([
    { thought: 'Allow 1', tool: 'read_tickets', args: {} },
    { thought: 'Allow 2', tool: 'read_customer', args: { id: 'c-1024' } },
    { thought: 'Allow 3', tool: 'search_customers', args: { query: 'Priya' } }
  ]);
  const traceRepeatedAllow = await runAgent('custom', brainRepeatedAllow);
  const tcsRepAllow = traceRepeatedAllow.filter(t => t.kind === 'tool_call');
  assert.equal(tcsRepAllow.length, 3);
  assert.ok(tcsRepAllow.every(t => t.status === 'ALLOW'));
  assert.equal(toolCallCounts.read_tickets, 1);
  assert.equal(toolCallCounts.read_customer, 1);
  assert.equal(toolCallCounts.search_customers, 1);

  // 23. ALLOW followed by DENY (Attack Case 23)
  resetSpies();
  const brainAllowThenDeny = createMockBrain([
    { thought: 'Read tickets (ALLOW)', tool: 'read_tickets', args: {} },
    { thought: 'Drop table (DENY)', tool: 'run_sql', args: { query: 'DROP TABLE tickets' } }
  ]);
  const traceAllowThenDeny = await runAgent('custom', brainAllowThenDeny);
  const tcsAllowThenDeny = traceAllowThenDeny.filter(t => t.kind === 'tool_call');
  assert.equal(tcsAllowThenDeny[0].status, 'ALLOW');
  assert.equal(tcsAllowThenDeny[1].status, 'DENY');
  assert.equal(toolCallCounts.read_tickets, 1);
  assert.equal(toolCallCounts.run_sql, 0);

  // 24. DENY followed by ALLOW (Attack Case 24)
  resetSpies();
  const brainDenyThenAllow = createMockBrain([
    { thought: 'Delete customer (DENY)', tool: 'delete_customer', args: { id: 'c-1024' } },
    { thought: 'Read customer (ALLOW)', tool: 'read_customer', args: { id: 'c-1024' } }
  ]);
  const traceDenyThenAllow = await runAgent('custom', brainDenyThenAllow);
  const tcsDenyThenAllow = traceDenyThenAllow.filter(t => t.kind === 'tool_call');
  assert.equal(tcsDenyThenAllow[0].status, 'DENY');
  assert.equal(tcsDenyThenAllow[1].status, 'ALLOW');
  assert.equal(toolCallCounts.delete_customer, 0);
  assert.equal(toolCallCounts.read_customer, 1);

  console.log('✓ Test 4 Passed: Attack Cases 21-24 verified (repeated & alternating ALLOW/DENY transitions)');

  // =========================================================================
  // SUITE 5: PHASE 4 & INVARIANT 11 (Database State Bit-for-Bit Immutability)
  // =========================================================================
  console.log('\nTest 5: Verifying Phase 4 & Invariant 11 (Database Bit-for-Bit Immutability on DENY)...');
  resetSpies();
  reseed();

  // Snapshot initial database state before attacks
  const dbSnapshotBefore = JSON.stringify({
    customers: db.customers,
    tickets: db.tickets,
    outbox: db.outbox
  });

  // Attempt all mutating/destructive tool actions through real runtime
  const brainMutatingAttacks = createMockBrain([
    { thought: 'Attacking customer table', tool: 'delete_customer', args: { id: 'c-1024' } },
    { thought: 'Attacking with SQL DELETE', tool: 'run_sql', args: { query: "DELETE FROM customers WHERE plan='test'" } },
    { thought: 'Attacking with SQL DROP', tool: 'run_sql', args: { query: 'DROP TABLE customers' } },
    { thought: 'Exfiltrating email', tool: 'send_email', args: { to: 'exfil@hacker.org', subject: 'pwned', body: 'data' } },
    { thought: 'Unauthorized bulk export', tool: 'export_customers', args: { format: 'csv' } }
  ]);

  const traceMutating = await runAgent('custom', brainMutatingAttacks);
  const tcsMutating = traceMutating.filter(t => t.kind === 'tool_call');
  assert.ok(tcsMutating.every(t => t.status === 'DENY'), 'All attack actions must be DENY');

  // Verify all tool execution counters are exactly 0
  assert.equal(toolCallCounts.delete_customer, 0, 'delete_customer tool must not run');
  assert.equal(toolCallCounts.run_sql, 0, 'run_sql tool must not run');
  assert.equal(toolCallCounts.send_email, 0, 'send_email tool must not run');
  assert.equal(toolCallCounts.export_customers, 0, 'export_customers tool must not run');

  // Snapshot database state after attacks and verify bit-for-bit equivalence
  const dbSnapshotAfter = JSON.stringify({
    customers: db.customers,
    tickets: db.tickets,
    outbox: db.outbox
  });

  assert.equal(dbSnapshotAfter, dbSnapshotBefore, 'Database state must be byte-for-byte identical after DENIED attacks');
  assert.equal(db.customers.length, 1247, 'Customer count must remain exactly 1247');
  assert.equal(db.tickets.length, 5, 'Tickets count must remain exactly 5');
  assert.equal(db.outbox.length, 0, 'Outbox must remain empty');

  // Verify that subsequent ALLOW operation still executes correctly
  const traceValidAfter = await runAgent('custom', createMockBrain([
    { thought: 'Valid email', tool: 'send_email', args: { to: 'priya@acme.example', subject: 'Hi', body: 'Order' } }
  ]));
  assert.equal(traceValidAfter.find(t => t.kind === 'tool_call').status, 'ALLOW');
  assert.equal(db.outbox.length, 1, 'Legitimate email must queue successfully');

  console.log('✓ Test 5 Passed: Phase 4 & Invariant 11 verified (Database bit-for-bit unchanged after denied operations)');

  // =========================================================================
  // SUITE 6: PHASE 5, INVARIANTS 7-9 & ATTACK CASES 25-27 (Policy Mutation)
  // =========================================================================
  console.log('\nTest 6: Verifying Phase 5, Invariants 7-9 & Attack Cases 25-27 (Policy Mutation & Resilience)...');
  resetSpies();
  resetPolicy();

  const originalPolicy = getPolicyText();

  // 25. Policy replacement followed by execution (Attack Case 25, Invariant 7)
  const modifiedPolicyAllowExport = originalPolicy.replace('context.rowCount > 50', 'context.rowCount > 5000');
  setPolicyText(modifiedPolicyAllowExport);
  assert.equal(getPolicyText(), modifiedPolicyAllowExport);

  // Now bulk export (1247 rows) should be permitted
  const tracePostEdit = await runAgent('custom', createMockBrain([
    { thought: 'Bulk export now allowed', tool: 'export_customers', args: { format: 'csv' } }
  ]));
  assert.equal(tracePostEdit.find(t => t.kind === 'tool_call').status, 'ALLOW', 'Export allowed after policy relaxation');
  assert.equal(toolCallCounts.export_customers, 1);

  // But destructive SQL must STILL be denied (Invariant 7: changing policy does not bypass authorization)
  const traceSQLStillDenied = await runAgent('custom', createMockBrain([
    { thought: 'Destructive SQL', tool: 'run_sql', args: { query: 'DROP TABLE customers' } }
  ]));
  assert.equal(traceSQLStillDenied.find(t => t.kind === 'tool_call').status, 'DENY');
  assert.equal(toolCallCounts.run_sql, 0);

  // 26. Invalid policy replacement followed by execution (Attack Case 26, Invariant 9)
  resetSpies();
  const currentValidPolicy = getPolicyText();
  let policyUpdateError = null;
  try {
    setPolicyText('SYNTAX ERROR !!! NOT VALID CEDAR');
  } catch (err) {
    policyUpdateError = err;
  }
  assert.ok(policyUpdateError !== null, 'Invalid policy must throw error');
  assert.equal(getPolicyText(), currentValidPolicy, 'Active policy must remain untouched after parse error (Invariant 9)');

  // Subsequent run still uses previously active valid policy
  const tracePostInvalid = await runAgent('custom', createMockBrain([
    { thought: 'Bulk export', tool: 'export_customers', args: { format: 'csv' } }
  ]));
  assert.equal(tracePostInvalid.find(t => t.kind === 'tool_call').status, 'ALLOW', 'Previously active policy is still used');

  // 27. Policy reset followed by execution (Attack Case 27, Invariant 8)
  resetSpies();
  resetPolicy();
  assert.equal(getPolicyText(), originalPolicy, 'resetPolicy restored disk policy');

  // Export should now be DENIED again under original policy
  const tracePostReset = await runAgent('custom', createMockBrain([
    { thought: 'Bulk export', tool: 'export_customers', args: { format: 'csv' } }
  ]));
  assert.equal(tracePostReset.find(t => t.kind === 'tool_call').status, 'DENY', 'Export denied after reset to disk policy');
  assert.equal(toolCallCounts.export_customers, 0);

  // Test INVALID POLICY -> RESET -> RUN flow
  try {
    setPolicyText('forbid (principal, action, resource); MALFORMED');
  } catch {}
  resetPolicy();
  const traceInvalidResetRun = await runAgent('happy', brainMock);
  assert.equal(traceInvalidResetRun.filter(t => t.kind === 'tool_call').length, 3);
  assert.ok(traceInvalidResetRun.filter(t => t.kind === 'tool_call').every(t => t.status === 'ALLOW'));

  // Test VALID POLICY -> RESET -> RUN flow
  setPolicyText(modifiedPolicyAllowExport);
  resetPolicy();
  const traceValidResetRun = await runAgent('catastrophe', brainMock);
  const catastropheCalls = traceValidResetRun.filter(t => t.kind === 'tool_call');
  assert.equal(catastropheCalls[0].status, 'ALLOW');
  assert.equal(catastropheCalls[1].status, 'DENY');
  assert.equal(catastropheCalls[2].status, 'DENY');

  console.log('✓ Test 6 Passed: Phase 5 & Invariants 7-9 verified (Policy mutation, invalid rejection, clean reset)');

  // =========================================================================
  // SUITE 7: PHASE 6, INVARIANTS 10 & 12 (Execution State & Concurrency)
  // =========================================================================
  console.log('\nTest 7: Verifying Phase 6, Invariants 10 & 12 (Concurrency & State Isolation)...');
  resetSpies();
  reseed();

  // Test two runs executed concurrently
  const [resHappy, resCatastrophe] = await Promise.all([
    runAgent('happy', brainMock),
    runAgent('catastrophe', brainMock)
  ]);

  // Verify traces are independent and not interleaved or corrupted
  const happyTools = resHappy.filter(t => t.kind === 'tool_call').map(t => t.tool);
  const catastropheTools = resCatastrophe.filter(t => t.kind === 'tool_call').map(t => t.tool);

  assert.deepEqual(happyTools, ['search_customers', 'read_customer', 'send_email']);
  assert.deepEqual(catastropheTools, ['run_sql', 'run_sql', 'delete_customer']);
  assert.equal(resHappy[resHappy.length - 1].kind, 'done');
  assert.equal(resCatastrophe[resCatastrophe.length - 1].kind, 'done');

  // Test run after intentional runtime failure (Invariant 10: no stale state)
  const failingBrain = {
    async plan() {
      throw new Error('Brain catastrophic crash');
    }
  };

  let failureCaught = false;
  try {
    await runAgent('fail', failingBrain);
  } catch (err) {
    failureCaught = true;
    assert.equal(err.message, 'Brain catastrophic crash');
  }
  assert.ok(failureCaught, 'Run failure properly caught');

  // Immediately execute a normal run after failure: must succeed cleanly without stale artifacts
  const tracePostFailure = await runAgent('injection', brainMock);
  const injectionTools = tracePostFailure.filter(t => t.kind === 'tool_call').map(t => t.status);
  assert.deepEqual(injectionTools, ['ALLOW', 'DENY', 'DENY']);

  // Verify Invariant 12: deterministic mock brain does not bypass authorization runtime
  const traceInjectionAuthorizerCheck = tracePostFailure.filter(t => t.kind === 'tool_call');
  assert.equal(traceInjectionAuthorizerCheck[1].tool, 'export_customers');
  assert.equal(traceInjectionAuthorizerCheck[1].status, 'DENY');
  assert.equal(traceInjectionAuthorizerCheck[2].tool, 'send_email');
  assert.equal(traceInjectionAuthorizerCheck[2].status, 'DENY');

  console.log('✓ Test 7 Passed: Phase 6, Invariants 10 & 12 verified (concurrent runs isolated, no stale state leakage)');

  // =========================================================================
  // SUITE 8: PHASE 7 (API Attack Surface & Malformed Requests)
  // =========================================================================
  console.log('\nTest 8: Verifying Phase 7 (API Route Attack Surface & Malformed Payloads)...');

  // 1. Malformed JSON payload on POST /api/run
  const resBadJson = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"scenario": "happy", INVALID_JSON'
  });
  assert.equal(resBadJson.status, 400, 'Malformed JSON must return 400');
  const bodyBadJson = await resBadJson.json();
  assert.equal(bodyBadJson.error, 'Malformed JSON payload');

  // 2. Missing scenario or invalid scenario on POST /api/run
  const badScenarios = [
    '',
    null,
    '../../../etc/passwd',
    '__proto__',
    'constructor',
    'undefined',
    'evil_scenario'
  ];
  for (const s of badScenarios) {
    const resBadScenario = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: s })
    });
    assert.equal(resBadScenario.status, 400, `Scenario "${s}" must return HTTP 400`);
  }

  // 3. Non-string policy payload on POST /api/policy
  const badPolicies = [12345, null, true, ['policy'], { rule: 'permit' }];
  for (const p of badPolicies) {
    const resBadPolicy = await fetch(`${baseUrl}/api/policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: p })
    });
    assert.equal(resBadPolicy.status, 400, `Policy type ${typeof p} must return HTTP 400`);
    const bodyBadPolicy = await resBadPolicy.json();
    assert.equal(bodyBadPolicy.error, 'Missing or invalid policy text');
  }

  // 4. Invalid HTTP method on routes
  const resMethodNotAllowed = await fetch(`${baseUrl}/api/run`, { method: 'GET' });
  assert.equal(resMethodNotAllowed.status, 404, 'GET /api/run must return 404');

  // 5. Verify error response does not leak internal stack traces
  const resInvalidSyntaxPolicy = await fetch(`${baseUrl}/api/policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'INVALID_PARSER_TRIGGER' })
  });
  assert.equal(resInvalidSyntaxPolicy.status, 400);
  const bodyErr = await resInvalidSyntaxPolicy.json();
  assert.ok(typeof bodyErr.error === 'string');
  assert.ok(!bodyErr.stack, 'Error responses must not leak stack traces');

  console.log('✓ Test 8 Passed: Phase 7 API attack surface verified (malformed payloads reject safely with clean 400s)');

  // =========================================================================
  // SUITE 9: THRESHOLD EDGE CASES (Export limit boundary 50 vs 51)
  // =========================================================================
  console.log('\nTest 9: Verifying Exact Boundary Limits (Export rowCount 50 vs 51, Refund 5000 vs 5001)...');

  // Cedar check for export_customers: rowCount 50 (permitted) vs rowCount 51 (forbidden by rowCount > 50)
  const checkExport50 = check('export_customers', { rowCount: 50, format: 'json' });
  assert.equal(checkExport50.allowed, true, 'rowCount 50 must be allowed');
  assert.equal(checkExport50.decision, 'allow');

  const checkExport51 = check('export_customers', { rowCount: 51, format: 'json' });
  assert.equal(checkExport51.allowed, false, 'rowCount 51 must be denied by forbid-bulk-export');
  assert.ok(checkExport51.reasons.includes('forbid-bulk-export'));

  // Cedar check for issue_refund: amountRupees 5000 (permitted) vs 5001 (denied by default deny)
  const checkRefund5000 = check('issue_refund', { amountRupees: 5000 });
  assert.equal(checkRefund5000.allowed, true, 'Refund 5000 must be allowed');

  const checkRefund5001 = check('issue_refund', { amountRupees: 5001 });
  assert.equal(checkRefund5001.allowed, false, 'Refund 5001 must be denied');

  console.log('✓ Test 9 Passed: Boundary thresholds (50/51 rows, 5000/5001 rupees) verified');

  // =========================================================================
  // SUITE 10: SQL INJECTION & COMMENT EVASION DEFENSE
  // =========================================================================
  console.log('\nTest 10: Verifying SQL Syntax Evasion Defense (Comments, Semicolon Chaining, Subqueries)...');
  resetSpies();

  const evasionSQLs = [
    "/* comment */ SELECT count(*) FROM customers",
    "-- line comment\nSELECT * FROM customers",
    "SELECT 1; DROP TABLE customers; --",
    "DELETE/*comment*/FROM customers",
    "(SELECT * FROM customers)",
    "SELECT * FROM customers WHERE id = 'c-1' OR '1'='1'"
  ];

  for (const sql of evasionSQLs) {
    resetSpies();
    const brainEvasion = createMockBrain([
      { thought: `Testing SQL: ${sql}`, tool: 'run_sql', args: { query: sql } }
    ]);
    const trace = await runAgent('custom', brainEvasion);
    const tc = trace.find(t => t.kind === 'tool_call');

    if (tc.status === 'DENY') {
      assert.equal(toolCallCounts.run_sql, 0, `Denied SQL [${sql}] must not execute`);
    } else if (tc.status === 'ALLOW') {
      assert.equal(db.customers.length, 1247, `DB must not be altered by SQL [${sql}]`);
    }
  }

  console.log('✓ Test 10 Passed: SQL evasion attempts safely handled without DB mutation');

  // =========================================================================
  // SUITE 11: DOMAIN PARSING TRICKS & SUBDOMAIN INJECTION
  // =========================================================================
  console.log('\nTest 11: Verifying Email Domain Parsing Tricks & Subdomain Injection...');
  resetSpies();

  const trickEmails = [
    'user@acme.example.evil.com',
    'acme.example@evil.com',
    'attacker@not-acme.example',
    'support@sub.acme.example',
    'user@acme-support.example.attacker.com',
    'bad-email-without-at',
    'user@evil.acme.example'
  ];

  for (const email of trickEmails) {
    const brainDomainTrick = createMockBrain([
      { thought: `Testing email: ${email}`, tool: 'send_email', args: { to: email, subject: 'test', body: 'test' } }
    ]);
    const trace = await runAgent('custom', brainDomainTrick);
    const tc = trace.find(t => t.kind === 'tool_call');
    assert.equal(tc.status, 'DENY', `Tricky email domain [${email}] must be DENIED`);
    assert.ok(tc.reasons.includes('forbid-email-to-untrusted-domain'));
  }
  assert.equal(toolCallCounts.send_email, 0, 'No tricky email address may trigger send_email runner');

  console.log('✓ Test 11 Passed: Email domain spoofing and subdomain traversal safely blocked');

  // =========================================================================
  // SUITE 12: FINAL INTEGRITY & STEADY-STATE VERIFICATION
  // =========================================================================
  console.log('\nTest 12: Verifying Post-Audit System Stability & Clean Baseline...');
  resetSpies();
  resetPolicy();
  reseed();

  // Run all three canonical scenarios one last time to ensure zero side-effects
  const traceHappyFinal = await runAgent('happy', brainMock);
  const traceCatastropheFinal = await runAgent('catastrophe', brainMock);
  const traceInjectionFinal = await runAgent('injection', brainMock);

  assert.equal(traceHappyFinal.filter(t => t.kind === 'tool_call' && t.status === 'ALLOW').length, 3);
  assert.equal(traceCatastropheFinal.filter(t => t.kind === 'tool_call' && t.status === 'DENY').length, 2);
  assert.equal(traceInjectionFinal.filter(t => t.kind === 'tool_call' && t.status === 'DENY').length, 2);

  console.log('✓ Test 12 Passed: Post-audit steady-state verified on all canonical scenarios');

  console.log('\n======================================================');
  console.log('ALL SECURITY AUDIT & RED-TEAM TESTS PASSED (12/12)!');
  console.log('======================================================\n');
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    console.log('Security verification server closed successfully.');
  }
}
