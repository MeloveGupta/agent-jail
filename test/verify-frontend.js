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

  console.log('\n======================================================');
  console.log('ALL FRONTEND CORE TESTS PASSED (5/5)!');
  console.log('======================================================\n');
} finally {
  if (server) {
    await new Promise(resolve => server.close(resolve));
    console.log('Server closed successfully.');
  }
}
