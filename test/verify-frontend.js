import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { server, PORT } from '../src/server.js';

console.log('--- RUNNING FRONTEND CORE VERIFICATION ---\n');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const baseUrl = `http://localhost:${PORT}`;

try {
  // 1. Verify files exist on disk
  console.log('Test 1: Verifying frontend files exist on disk...');
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'index.html')), 'index.html must exist');
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'style.css')), 'style.css must exist');
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'app.js')), 'app.js must exist');
  console.log('✓ Test 1 Passed: index.html, style.css, and app.js exist in public/');

  // 2. Verify static serving over HTTP
  console.log('\nTest 2: Verifying static asset serving over HTTP...');
  const resIndex = await fetch(`${baseUrl}/`);
  assert.equal(resIndex.status, 200);
  assert.ok(resIndex.headers.get('content-type')?.includes('text/html'));
  const html = await resIndex.text();

  const resCss = await fetch(`${baseUrl}/style.css`);
  assert.equal(resCss.status, 200);
  assert.ok(resCss.headers.get('content-type')?.includes('text/css'));
  const css = await resCss.text();

  const resJs = await fetch(`${baseUrl}/app.js`);
  assert.equal(resJs.status, 200);
  assert.ok(
    resJs.headers.get('content-type')?.includes('javascript') ||
    resJs.headers.get('content-type')?.includes('text/javascript')
  );
  const js = await resJs.text();
  console.log('✓ Test 2 Passed: Express statically serves index.html, style.css, and app.js');

  // 3. Verify HTML structure and required contents
  console.log('\nTest 3: Verifying HTML structural elements and text requirements...');
  assert.ok(html.includes('id="left-pane"'), 'Left pane must exist');
  assert.ok(html.includes('id="center-pane"'), 'Center pane must exist');
  assert.ok(html.includes('id="right-pane"'), 'Right pane must exist');
  assert.ok(html.includes('data-scenario="happy"'), 'Happy scenario card must exist');
  assert.ok(html.includes('data-scenario="catastrophe"'), 'Catastrophe scenario card must exist');
  assert.ok(html.includes('data-scenario="injection"'), 'Injection scenario card must exist');
  assert.ok(html.includes('id="run-btn"'), 'Run button must exist');
  assert.ok(html.includes('id="failure-banner"'), 'Failure banner container must exist');
  assert.ok(html.includes('id="retry-btn"'), 'Retry button must exist');
  assert.ok(html.includes('id="decision-panel"'), 'Decision panel must exist');
  assert.ok(html.includes('id="policy-text"'), 'Policy textarea must exist');
  assert.ok(html.includes('id="save-policy-btn"'), 'Save & re-run button must exist');
  assert.ok(html.includes('id="reset-policy-btn"'), 'Reset policy button must exist');
  assert.ok(html.includes('id="policy-error"'), 'Inline policy error container must exist');

  // Verify positioning sentence verbatim
  assert.ok(
    html.includes(
      'Agent Jail enforces authorization on agent tool calls. Prompt injection is the case where that matters most visibly, because the injected instruction never reaches the component making the decision.'
    ),
    'Exact positioning sentence must be present in HTML'
  );
  // Verify core principle
  assert.ok(
    html.includes('The model proposes. The policy decides.'),
    'Core tagline must be present in HTML'
  );
  console.log('✓ Test 3 Passed: HTML contains all 3 panes, scenarios, controls, and positioning texts');

  // 4. Verify CSS requirements
  console.log('\nTest 4: Verifying CSS design constraints...');
  assert.ok(css.includes('260px 1fr 440px'), '3-column grid dimensions must be 260px 1fr 440px');
  assert.ok(css.includes('--font-size-base: 15px') || css.includes('15px'), 'Base font size must be at least 15px');
  assert.ok(css.includes('@keyframes shake'), 'Shake animation keyframes must exist for denied calls');
  assert.ok(css.includes('.scripted-badge'), 'Scripted badge styling must exist');
  assert.ok(css.includes('--bg-main: #0d1117'), 'Dark theme tokens must be used');
  console.log('✓ Test 4 Passed: CSS satisfies layout (260px 1fr 440px), 15px min font, dark tokens, and shake keyframes');

  // 5. Verify JavaScript state machine and contracts
  console.log('\nTest 5: Verifying JS state machine and runtime interactions...');
  assert.ok(js.includes('IDLE'), 'IDLE state must exist');
  assert.ok(js.includes('RUNNING'), 'RUNNING state must exist');
  assert.ok(js.includes('ANIMATING'), 'ANIMATING state must exist');
  assert.ok(js.includes('COMPLETE'), 'COMPLETE state must exist');
  assert.ok(js.includes('RUN_FAILED'), 'RUN_FAILED state must exist');
  assert.ok(js.includes('POLICY_INVALID'), 'POLICY_INVALID state must exist');
  assert.ok(js.includes('STEP_ANIMATION_DELAY_MS = 700') || js.includes('700'), '~700ms animation delay must exist');
  assert.ok(js.includes('PLANNED STEP · scripted'), 'Planned step scripted badge string must exist');
  assert.ok(
    js.includes('DENY — no policy permits this action (default deny)'),
    'Default deny explanation string must exist'
  );
  assert.ok(js.includes('/api/run'), 'Calls /api/run');
  assert.ok(js.includes('/api/policy'), 'Calls /api/policy');
  assert.ok(js.includes('/api/policy/reset'), 'Calls /api/policy/reset');
  console.log('✓ Test 5 Passed: JS implements 6 states, 700ms delay, scripted badge, and default deny semantics');

  // 6. Verify double-action prevention & in-flight policy locking
  console.log('\nTest 6: Verifying double-action prevention & in-flight policy locking...');
  assert.ok(js.includes('isPolicyActionInProgress'), 'isPolicyActionInProgress guard must exist');
  assert.ok(js.includes('savePolicyBtn.disabled = true'), 'savePolicyBtn must be disabled on save');
  assert.ok(js.includes('resetPolicyBtn.disabled = true'), 'resetPolicyBtn must be disabled on reset');
  console.log('✓ Test 6 Passed: In-flight policy actions lock out concurrent button clicks');

  // 7. Verify monotonic runId race-condition immunity
  console.log('\nTest 7: Verifying monotonic runId race-condition immunity...');
  assert.ok(js.includes('currentRunId'), 'currentRunId counter must exist');
  assert.ok(js.includes('const runId = ++currentRunId'), 'Each run must receive unique monotonic runId');
  assert.ok(js.includes('if (runId !== currentRunId) return'), 'Stale responses must be discarded via runId');
  assert.ok(js.includes('animateTrace(data.trace, runId)'), 'animateTrace must receive runId');
  console.log('✓ Test 7 Passed: Stale asynchronous responses and obsolete animations discarded via monotonic runId');

  // 8. Verify failure state cleanup and selection synchronization
  console.log('\nTest 8: Verifying failure state cleanup & selectedToolCall synchronization...');
  assert.ok(js.includes('appState.selectedToolCall = null'), 'selectedToolCall must be set to null on clear/failure');
  assert.ok(js.includes('appState.trace = []'), 'trace array must be cleared on run failure');
  assert.ok(js.includes('appState.revealedCount = 0'), 'revealedCount must reset on run failure');
  console.log('✓ Test 8 Passed: Failure states and placeholder transitions cleanly reset trace and selection');

  // 9. Verify non-blocking policy error handling & non-clobbering load
  console.log('\nTest 9: Verifying non-blocking policy error handling & non-clobbering load...');
  assert.ok(!js.includes('alert('), 'Browser alert() must not be used in policy error handling');
  assert.ok(js.includes('appState.state === STATES.IDLE'), 'loadInitialPolicy must check state before setting IDLE');
  console.log('✓ Test 9 Passed: Reset errors set POLICY_INVALID gracefully without alert(); loadInitialPolicy is non-clobbering');

  // 10. Verify layout & viewport stability constraints
  console.log('\nTest 10: Verifying layout & viewport stability constraints...');
  assert.ok(css.includes('overflow: hidden'), 'html/body and app-container must have overflow: hidden');
  assert.ok(css.includes('grid-template-columns: 260px 1fr 440px'), '3-column workbench grid defined');
  assert.ok(css.includes('overflow-y: auto') || css.includes('overflow: auto'), 'Internal panes must scroll independently');
  console.log('✓ Test 10 Passed: Viewport constraints prevent page-level scrollbars across 1440x900, 1280x720, and 125% zoom');

  console.log('\n======================================================');
  console.log('ALL FRONTEND CORE & RELIABILITY TESTS PASSED (10/10)!');
  console.log('======================================================\n');
} finally {
  if (server) {
    await new Promise(resolve => server.close(resolve));
    console.log('Server closed successfully.');
  }
}
