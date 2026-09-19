import assert from 'node:assert/strict';
import {
  check,
  getPolicyText,
  setPolicyText,
  resetPolicy,
  extractPolicyIds,
  STATIC_ENTITIES
} from '../src/cedar.js';

console.log('--- RUNNING CEDAR FOUNDATION VERIFICATION ---');

// 1. Verify that the policy file parses
console.log('Test 1: Verifying active policy text and parsed policy IDs...');
const policyText = getPolicyText();
assert.ok(policyText && policyText.length > 0, 'Policy text must not be empty');
const ids = extractPolicyIds(policyText);
console.log('Extracted Policy IDs:', ids);
assert.deepEqual(ids, [
  'allow-read-customer-data',
  'allow-readonly-sql',
  'allow-email',
  'allow-export',
  'allow-small-refunds',
  'forbid-destructive-sql',
  'forbid-bulk-export',
  'forbid-email-to-untrusted-domain'
]);
console.log('✓ Test 1 Passed: Policy file parsed and all 8 policy IDs extracted in source order');

// 2. Verify a permitted search_customers request returns Allow
console.log('Test 2: Verifying search_customers...');
const resSearch = check('search_customers');
assert.equal(resSearch.allowed, true);
assert.equal(resSearch.decision, 'allow');
assert.deepEqual(resSearch.reasons, ['allow-read-customer-data']);
assert.deepEqual(resSearch.errors, []);
console.log('✓ Test 2 Passed: search_customers allowed with allow-read-customer-data');

// 3. Verify a permitted SELECT run_sql request returns Allow
console.log('Test 3: Verifying SELECT run_sql...');
const resSqlSelect = check('run_sql', { sqlOperation: 'SELECT' });
assert.equal(resSqlSelect.allowed, true);
assert.equal(resSqlSelect.decision, 'allow');
assert.deepEqual(resSqlSelect.reasons, ['allow-readonly-sql']);
assert.deepEqual(resSqlSelect.errors, []);
console.log('✓ Test 3 Passed: SELECT run_sql allowed with allow-readonly-sql');

// 4. Verify a DELETE run_sql request returns Deny because of forbid-destructive-sql
console.log('Test 4: Verifying DELETE run_sql...');
const resSqlDelete = check('run_sql', { sqlOperation: 'DELETE' });
assert.equal(resSqlDelete.allowed, false);
assert.equal(resSqlDelete.decision, 'deny');
assert.deepEqual(resSqlDelete.reasons, ['forbid-destructive-sql']);
assert.deepEqual(resSqlDelete.errors, []);
console.log('✓ Test 4 Passed: DELETE run_sql denied with forbid-destructive-sql');

// 5. Verify export_customers with rowCount: 1247 is denied by forbid-bulk-export
console.log('Test 5: Verifying export_customers rowCount: 1247...');
const resExportBulk = check('export_customers', { rowCount: 1247 });
assert.equal(resExportBulk.allowed, false);
assert.equal(resExportBulk.decision, 'deny');
assert.deepEqual(resExportBulk.reasons, ['forbid-bulk-export']);
assert.deepEqual(resExportBulk.errors, []);
console.log('✓ Test 5 Passed: export_customers rowCount: 1247 denied with forbid-bulk-export');

// Also verify small export (e.g. rowCount: 20) is allowed
const resExportSmall = check('export_customers', { rowCount: 20 });
assert.equal(resExportSmall.allowed, true);
assert.equal(resExportSmall.decision, 'allow');
assert.deepEqual(resExportSmall.reasons, ['allow-export']);

// 6. Verify trusted email is allowed
console.log('Test 6: Verifying trusted email...');
const resEmailTrusted = check('send_email', { trusted: true });
assert.equal(resEmailTrusted.allowed, true);
assert.equal(resEmailTrusted.decision, 'allow');
assert.deepEqual(resEmailTrusted.reasons, ['allow-email']);
assert.deepEqual(resEmailTrusted.errors, []);
console.log('✓ Test 6 Passed: trusted email allowed with allow-email');

// 7. Verify untrusted email is denied by forbid-email-to-untrusted-domain
console.log('Test 7: Verifying untrusted email...');
const resEmailUntrusted = check('send_email', { trusted: false });
assert.equal(resEmailUntrusted.allowed, false);
assert.equal(resEmailUntrusted.decision, 'deny');
assert.deepEqual(resEmailUntrusted.reasons, ['forbid-email-to-untrusted-domain']);
assert.deepEqual(resEmailUntrusted.errors, []);
console.log('✓ Test 7 Passed: untrusted email denied with forbid-email-to-untrusted-domain');

// 8. Verify delete_customer is denied through default deny and does not have a fabricated policy reason
console.log('Test 8: Verifying delete_customer (default deny)...');
const resDelete = check('delete_customer');
assert.equal(resDelete.allowed, false);
assert.equal(resDelete.decision, 'deny');
assert.deepEqual(resDelete.reasons, []);
assert.deepEqual(resDelete.errors, []);
console.log('✓ Test 8 Passed: delete_customer denied through default deny (reasons: [])');

// 9. Verify issue_refund with amountRupees: 4000 is allowed
console.log('Test 9: Verifying issue_refund amountRupees: 4000...');
const resRefund4k = check('issue_refund', { amountRupees: 4000 });
assert.equal(resRefund4k.allowed, true);
assert.equal(resRefund4k.decision, 'allow');
assert.deepEqual(resRefund4k.reasons, ['allow-small-refunds']);
assert.deepEqual(resRefund4k.errors, []);
console.log('✓ Test 9 Passed: issue_refund amountRupees: 4000 allowed with allow-small-refunds');

// 10. Verify issue_refund with amountRupees: 9000 is denied
console.log('Test 10: Verifying issue_refund amountRupees: 9000...');
const resRefund9k = check('issue_refund', { amountRupees: 9000 });
assert.equal(resRefund9k.allowed, false);
assert.equal(resRefund9k.decision, 'deny');
assert.deepEqual(resRefund9k.reasons, []);
assert.deepEqual(resRefund9k.errors, []);
console.log('✓ Test 10 Passed: issue_refund amountRupees: 9000 denied by default deny (amountRupees > 5000)');

// 11. Verify setPolicyText rejects invalid syntax without modifying active policy
console.log('Test 11: Verifying setPolicyText error handling & immutability on failure...');
const originalText = getPolicyText();
assert.throws(() => {
  setPolicyText('SYNTAX ERROR !!! NOT VALID CEDAR');
}, /failed to parse/i);
assert.equal(getPolicyText(), originalText, 'Active policy must remain untouched on parse failure');
// Check that check() still uses the original policy
const resStillWorks = check('search_customers');
assert.equal(resStillWorks.allowed, true);
console.log('✓ Test 11 Passed: Invalid policy rejected and active policy preserved');

// 12. Verify dynamic policy editing (e.g. changing export threshold to 5000)
console.log('Test 12: Verifying dynamic policy editing and re-evaluation...');
const modifiedPolicy = originalText.replace('context.rowCount > 50', 'context.rowCount > 5000');
setPolicyText(modifiedPolicy);
const resExportAfterEdit = check('export_customers', { rowCount: 1247 });
assert.equal(resExportAfterEdit.allowed, true, 'Export with 1247 rows should now be allowed');
assert.equal(resExportAfterEdit.decision, 'allow');
assert.deepEqual(resExportAfterEdit.reasons, ['allow-export']);
console.log('✓ Test 12 Passed: Dynamic policy update allowed export_customers with rowCount: 1247');

// 13. Verify resetPolicy restores original disk policy
console.log('Test 13: Verifying resetPolicy()...');
resetPolicy();
const resExportAfterReset = check('export_customers', { rowCount: 1247 });
assert.equal(resExportAfterReset.allowed, false, 'Export with 1247 rows should be denied again after reset');
assert.deepEqual(resExportAfterReset.reasons, ['forbid-bulk-export']);
console.log('✓ Test 13 Passed: resetPolicy() restored disk policy');

// 14. Verify fail closed on Cedar evaluation error
console.log('Test 14: Verifying fail-closed security semantics when context evaluation errors...');
// When rowCount is referenced in forbid-bulk-export condition, omitting context produces evaluation error
const resMissingContext = check('export_customers');
assert.equal(resMissingContext.allowed, false, 'Must fail closed when evaluation errors occur');
assert.ok(resMissingContext.errors.length > 0, 'Must surface errors');
console.log('✓ Test 14 Passed: Evaluation error fails closed with allowed: false and populated errors');

console.log('\n========================================');
console.log('ALL CEDAR FOUNDATION TESTS PASSED (14/14)!');
console.log('========================================\n');
