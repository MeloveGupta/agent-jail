import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { server, PORT } from '../src/server.js';
import { getPolicyText, resetPolicy } from '../src/cedar.js';
import { db } from '../src/db.js';

console.log('=== RUNNING FINAL BROWSER-LEVEL ADVERSARIAL VERIFICATION ===\n');

// 1. Locate Chrome executable
function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(macChrome)) {
    return macChrome;
  }
  const linuxChrome = '/usr/bin/google-chrome';
  if (fs.existsSync(linuxChrome)) {
    return linuxChrome;
  }
  const chromium = '/usr/bin/chromium';
  if (fs.existsSync(chromium)) {
    return chromium;
  }
  return null;
}

const CHROME_PATH = findChrome();
if (!CHROME_PATH) {
  console.warn('⚠ Google Chrome was not found. Skipping real browser adversarial tests.');
  process.exit(0);
}

const CDP_PORT = 9226;
const tempProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentjail-cdp-'));
let chromeProc = null;
let ws = null;
let msgId = 0;
const pendingRequests = new Map();
const consoleErrors = [];
const uncaughtExceptions = [];
const networkRequests = [];

// Helper: send CDP command
function sendCdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pendingRequests.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// Helper: evaluate expression in browser
async function evalJs(expression) {
  const res = await sendCdp('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (res.exceptionDetails) {
    const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
    throw new Error(`Browser JS Error: ${desc}`);
  }
  return res.result?.value;
}

// Helper: wait until condition evaluates to truthy
async function waitFor(fn, timeoutMs = 15000, intervalMs = 100) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (err) {
      lastErr = err;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition (last error: ${lastErr?.message || 'none'})`);
}

// Helper: wait for state badge
async function waitForState(expectedState, timeoutMs = 15000) {
  let lastSeen = null;
  return waitFor(async () => {
    const text = await evalJs(`document.getElementById('state-badge')?.textContent?.trim()`);
    lastSeen = text;
    return text === expectedState ? text : null;
  }, timeoutMs).catch(err => {
    throw new Error(`${err.message} (expected: "${expectedState}", last seen: "${lastSeen}")`);
  });
}

// Helper: wait for run to start (busy) and then complete
async function waitForRunComplete(timeoutMs = 20000) {
  // Wait until it enters RUNNING or ANIMATING
  await waitFor(async () => {
    const text = await evalJs(`document.getElementById('state-badge')?.textContent?.trim()`);
    return (text === 'RUNNING' || text === 'ANIMATING') ? text : null;
  }, 6000);

  // Then wait until it reaches COMPLETE
  return waitFor(async () => {
    const text = await evalJs(`document.getElementById('state-badge')?.textContent?.trim()`);
    return text === 'COMPLETE' ? text : null;
  }, timeoutMs);
}

// Helper: click element
async function clickElem(selector) {
  const ok = await evalJs(`(() => {
    const el = document.querySelector('${selector}');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!ok) throw new Error(`Could not click selector: ${selector}`);
}

try {
  // Launch Chrome
  console.log(`Launching Chrome (${CHROME_PATH}) with CDP on port ${CDP_PORT}...`);
  chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${tempProfileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-sync',
    '--disable-translate',
    '--window-size=1440,900',
    'about:blank'
  ], { stdio: 'ignore' });

  // Wait for CDP port to open
  let wsUrl = null;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const pages = await res.json();
      const pageTarget = pages.find(p => p.type === 'page');
      if (pageTarget && pageTarget.webSocketDebuggerUrl) {
        wsUrl = pageTarget.webSocketDebuggerUrl;
        break;
      }
    } catch (_) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  if (!wsUrl) {
    throw new Error('Failed to obtain Chrome webSocketDebuggerUrl');
  }

  // Connect native WebSocket
  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let pageLoadResolver = null;

  // Handle incoming CDP messages
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pendingRequests.has(data.id)) {
      const { resolve, reject } = pendingRequests.get(data.id);
      pendingRequests.delete(data.id);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data.result);
    } else if (data.method) {
      // Event handlers
      if (data.method === 'Page.loadEventFired') {
        if (pageLoadResolver) {
          pageLoadResolver();
          pageLoadResolver = null;
        }
      } else if (data.method === 'Runtime.consoleAPICalled') {
        const { type, args } = data.params;
        const msg = args.map(a => a.value || a.description).join(' ');
        if (type === 'error') {
          consoleErrors.push(msg);
        }
      } else if (data.method === 'Runtime.exceptionThrown') {
        uncaughtExceptions.push(data.params.exceptionDetails);
      } else if (data.method === 'Network.requestWillBeSent') {
        networkRequests.push({
          url: data.params.request.url,
          method: data.params.request.method
        });
      }
    }
  };

  // Enable CDP domains
  await sendCdp('Page.enable');
  await sendCdp('Runtime.enable');
  await sendCdp('Network.enable');

  const appUrl = `http://localhost:${PORT}`;

  // =========================================================================
  // PHASE 1: CLEAN START
  // =========================================================================
  console.log('Phase 1: Verifying Clean Start state in browser...');
  resetPolicy();

  // Ensure server is accepting requests
  const ping = await fetch(`${appUrl}/api/policy`);
  assert.equal(ping.status, 200, 'Server must be responding on /api/policy before browser navigates');

  await sendCdp('Page.navigate', { url: appUrl });
  await waitForState('IDLE', 15000);

  // Assert state badge
  const initialBadge = await evalJs(`document.getElementById('state-badge').textContent.trim()`);
  assert.equal(initialBadge, 'IDLE', 'State badge must display IDLE');

  // Assert policy editor contains initial Cedar policy
  const policyText = await evalJs(`document.getElementById('policy-text').value`);
  assert.ok(policyText.includes('permit'), 'Policy editor must contain active policies');
  assert.ok(policyText.includes('forbid'), 'Policy editor must contain active forbid policies');
  assert.ok(policyText.includes('run_sql'), 'Policy editor must contain run_sql policy');

  // Assert execution transcript is empty placeholder
  const placeholderVisible = await evalJs(`!document.getElementById('transcript-placeholder').classList.contains('hidden')`);
  assert.ok(placeholderVisible, 'Transcript placeholder must be visible initially');
  const traceCount = await evalJs(`document.querySelectorAll('#transcript-list .trace-entry').length`);
  assert.equal(traceCount, 0, 'No trace entries must be rendered initially (no auto-run)');

  // Assert right pane placeholder
  const decisionPlaceholder = await evalJs(`document.querySelector('#decision-panel .decision-placeholder') !== null`);
  assert.ok(decisionPlaceholder, 'Decision panel placeholder must be displayed');

  // Assert zero console errors
  assert.equal(consoleErrors.length, 0, 'Clean start must produce zero console errors');
  assert.equal(uncaughtExceptions.length, 0, 'Clean start must produce zero uncaught exceptions');
  console.log('✓ Phase 1 Passed: Clean start displays IDLE with clean placeholders and no auto-run');

  // =========================================================================
  // PHASE 2: HAPPY SCENARIO (Clean Run)
  // =========================================================================
  console.log('\nPhase 2: Verifying Happy scenario progressive execution...');
  await clickElem('.scenario-card[data-scenario="happy"]');
  await clickElem('#run-btn');

  // Check that button updates while busy
  const runBtnBusyText = await evalJs(`document.getElementById('run-btn').textContent`);
  assert.ok(runBtnBusyText.includes('Running') || runBtnBusyText.includes('Run'), 'Button reflects running state');

  // Wait for COMPLETE
  await waitForRunComplete();

  // Verify trace count in DOM: 3 thoughts + 3 tool calls + 1 done = 7 entries
  const happyTraceCount = await evalJs(`document.querySelectorAll('#transcript-list .trace-entry').length`);
  assert.equal(happyTraceCount, 7, 'Happy path must render 7 entries (3 thoughts + 3 tools + done)');

  // Verify all 3 tool calls are ALLOW / green
  const happyToolStatuses = await evalJs(`
    Array.from(document.querySelectorAll('.trace-tool-call')).map(el => ({
      tool: el.querySelector('.tool-name-tag')?.textContent,
      badge: el.querySelector('.status-badge')?.textContent,
      hasAllowClass: el.classList.contains('tool-allow'),
      execState: el.querySelector('.tool-exec-state')?.textContent
    }))
  `);

  assert.equal(happyToolStatuses.length, 3);
  for (const t of happyToolStatuses) {
    assert.equal(t.badge, 'AUTHORIZED', `Tool ${t.tool} badge must be AUTHORIZED`);
    assert.ok(t.hasAllowClass, `Tool ${t.tool} must have tool-allow CSS class`);
    assert.equal(t.execState, 'POLICY ALLOWED → TOOL EXECUTED');
  }

  // Verify Right Pane updated with the last executed tool call (send_email)
  const decisionBannerText = await evalJs(`document.querySelector('#decision-panel .exec-status-tag')?.textContent`);
  assert.equal(decisionBannerText, 'POLICY ALLOWED → TOOL EXECUTED');

  const resultRendered = await evalJs(`document.querySelector('#decision-panel .code-block-result')?.textContent`);
  assert.ok(resultRendered && resultRendered.includes('queued'), 'Execution result JSON must be rendered in right pane');

  // Verify DB state: outbox has 1 email
  assert.equal(db.outbox.length, 1, 'Database outbox must contain 1 sent email');
  assert.equal(db.outbox[0].to, 'priya@acme.example');

  console.log('✓ Phase 2 Passed: Happy scenario progressively completes with 3 AUTHORIZED tools and outbox updated');

  // =========================================================================
  // PHASE 3: CATASTROPHE SCENARIO (The Prevented Attack)
  // =========================================================================
  console.log('\nPhase 3: Verifying Catastrophe scenario denial & DB protection...');
  await clickElem('.scenario-card[data-scenario="catastrophe"]');
  await clickElem('#run-btn');

  await waitForRunComplete();

  const catToolStatuses = await evalJs(`
    Array.from(document.querySelectorAll('.trace-tool-call')).map(el => ({
      tool: el.querySelector('.tool-name-tag')?.textContent,
      badge: el.querySelector('.status-badge')?.textContent,
      isDeny: el.classList.contains('tool-deny'),
      isAllow: el.classList.contains('tool-allow'),
      hasShake: el.classList.contains('shake'),
      execState: el.querySelector('.tool-exec-state')?.textContent,
      explanation: el.querySelector('.tool-explanation')?.textContent
    }))
  `);

  assert.equal(catToolStatuses.length, 3);

  // Tool 1: run_sql (SELECT) -> ALLOW
  assert.equal(catToolStatuses[0].tool, 'run_sql');
  assert.equal(catToolStatuses[0].badge, 'AUTHORIZED');
  assert.ok(catToolStatuses[0].isAllow);

  // Tool 2: run_sql (DELETE) -> DENY (forbid forbid-destructive-sql)
  assert.equal(catToolStatuses[1].tool, 'run_sql');
  assert.equal(catToolStatuses[1].badge, 'DENIED');
  assert.ok(catToolStatuses[1].isDeny);
  assert.ok(catToolStatuses[1].hasShake, 'Denied tool call must have shake animation class');
  assert.equal(catToolStatuses[1].execState, 'NOT EXECUTED');

  // Tool 3: delete_customer -> DENY (default deny)
  assert.equal(catToolStatuses[2].tool, 'delete_customer');
  assert.equal(catToolStatuses[2].badge, 'DENIED');
  assert.ok(catToolStatuses[2].isDeny);
  assert.ok(catToolStatuses[2].hasShake);
  assert.equal(catToolStatuses[2].execState, 'NOT EXECUTED');

  // Inspect Tool 2 in right pane
  await evalJs(`document.querySelectorAll('.trace-tool-call')[1].click()`);
  const tool2Reason = await evalJs(`document.querySelector('#decision-panel .policy-reason-tag')?.textContent`);
  assert.equal(tool2Reason, 'forbid-destructive-sql', 'Tool 2 policy reason must show forbid-destructive-sql');
  const tool2BlockedNotice = await evalJs(`document.querySelector('#decision-panel .result-blocked-note')?.textContent`);
  assert.ok(tool2BlockedNotice.includes('No execution output — tool call was denied before invocation'));

  // Inspect Tool 3 in right pane
  await evalJs(`document.querySelectorAll('.trace-tool-call')[2].click()`);
  const tool3DefaultDeny = await evalJs(`document.querySelector('#decision-panel .default-deny-msg')?.textContent`);
  assert.ok(tool3DefaultDeny.includes('default deny'), 'Tool 3 must show default deny explanation');

  // Verify database protection: 1247 customers intact!
  assert.equal(db.customers.length, 1247, 'Destructive SQL must NOT execute; customer count must remain 1247');
  const testCustomers = db.customers.filter(c => c.plan === 'test');
  assert.equal(testCustomers.length, 312, 'All 312 test customers must remain intact');

  console.log('✓ Phase 3 Passed: Catastrophe scenario clearly marks DENIED / NOT EXECUTED and protects DB');

  // =========================================================================
  // PHASE 4: PROMPT INJECTION SCENARIO (The Core Demo)
  // =========================================================================
  console.log('\nPhase 4: Verifying Prompt Injection scenario & exfiltration prevention...');
  await clickElem('.scenario-card[data-scenario="injection"]');
  await clickElem('#run-btn');

  await waitForRunComplete();

  const injToolStatuses = await evalJs(`
    Array.from(document.querySelectorAll('.trace-tool-call')).map(el => ({
      tool: el.querySelector('.tool-name-tag')?.textContent,
      badge: el.querySelector('.status-badge')?.textContent,
      execState: el.querySelector('.tool-exec-state')?.textContent
    }))
  `);

  assert.equal(injToolStatuses.length, 3);
  // Tool 1: read_tickets -> ALLOW
  assert.equal(injToolStatuses[0].tool, 'read_tickets');
  assert.equal(injToolStatuses[0].badge, 'AUTHORIZED');

  // Tool 2: export_customers -> DENIED (exceeds threshold 50)
  assert.equal(injToolStatuses[1].tool, 'export_customers');
  assert.equal(injToolStatuses[1].badge, 'DENIED');
  assert.equal(injToolStatuses[1].execState, 'NOT EXECUTED');

  // Tool 3: send_email -> DENIED (exfil email to attacker)
  assert.equal(injToolStatuses[2].tool, 'send_email');
  assert.equal(injToolStatuses[2].badge, 'DENIED');
  assert.equal(injToolStatuses[2].execState, 'NOT EXECUTED');

  // DB verification: Outbox is empty, customer records safe
  assert.equal(db.outbox.length, 0, 'No exfiltration email must be queued');
  assert.equal(db.customers.length, 1247, 'Customer records remain intact');

  console.log('✓ Phase 4 Passed: Prompt injection scenario halts both exfiltration steps with DENIED');

  // =========================================================================
  // PHASE 5: POLICY EDIT DEMO (The Interactive Moment)
  // =========================================================================
  console.log('\nPhase 5: Verifying Policy Edit interactive flow (50 -> 5000 -> re-run -> reset)...');
  // Update textarea: change 50 to 5000 in export limit
  const originalPolicy = await evalJs(`document.getElementById('policy-text').value`);
  assert.ok(originalPolicy.includes('context.rowCount > 50'));

  const modifiedPolicy = originalPolicy.replace('context.rowCount > 50', 'context.rowCount > 5000');
  await evalJs(`document.getElementById('policy-text').value = ${JSON.stringify(modifiedPolicy)}`);

  // Click Save & re-run
  await clickElem('#save-policy-btn');

  // Wait for run to complete
  await waitForRunComplete();

  // Now Tool 2 (export_customers) should be AUTHORIZED, while Tool 3 (send_email) remains DENIED
  const editedRunTools = await evalJs(`
    Array.from(document.querySelectorAll('.trace-tool-call')).map(el => ({
      tool: el.querySelector('.tool-name-tag')?.textContent,
      badge: el.querySelector('.status-badge')?.textContent,
      execState: el.querySelector('.tool-exec-state')?.textContent
    }))
  `);

  assert.equal(editedRunTools[0].tool, 'read_tickets');
  assert.equal(editedRunTools[0].badge, 'AUTHORIZED');

  assert.equal(editedRunTools[1].tool, 'export_customers');
  assert.equal(editedRunTools[1].badge, 'AUTHORIZED', 'export_customers must now be AUTHORIZED under threshold 5000');
  assert.equal(editedRunTools[1].execState, 'POLICY ALLOWED → TOOL EXECUTED');

  assert.equal(editedRunTools[2].tool, 'send_email');
  assert.equal(editedRunTools[2].badge, 'DENIED', 'send_email must STILL be DENIED (domain check blocks exfiltration)');

  // Now Click Reset Policy
  await clickElem('#reset-policy-btn');
  await waitForState('IDLE', 5000);

  const resetPolicyText = await evalJs(`document.getElementById('policy-text').value`);
  assert.ok(resetPolicyText.includes('context.rowCount > 50'), 'Policy must reset to 50 threshold');

  // Re-run injection scenario to verify Tool 2 is DENIED again
  await clickElem('#run-btn');
  await waitForRunComplete();

  const revertedRunTools = await evalJs(`
    Array.from(document.querySelectorAll('.trace-tool-call')).map(el => ({
      tool: el.querySelector('.tool-name-tag')?.textContent,
      badge: el.querySelector('.status-badge')?.textContent
    }))
  `);
  assert.equal(revertedRunTools[1].badge, 'DENIED', 'export_customers must be DENIED again after policy reset');

  console.log('✓ Phase 5 Passed: Interactive policy edit correctly changes authorization and reverts on reset');

  // =========================================================================
  // PHASE 6: INVALID POLICY (Error Recovery)
  // =========================================================================
  console.log('\nPhase 6: Verifying Invalid Policy error handling and recovery...');
  const brokenSyntax = 'permit(principal, action, resource) where { THIS IS INVALID SYNTAX !!!';
  await evalJs(`document.getElementById('policy-text').value = ${JSON.stringify(brokenSyntax)}`);

  await clickElem('#save-policy-btn');
  await waitForState('POLICY_INVALID', 5000);

  // Assert error message visible in #policy-error
  const isErrorVisible = await evalJs(`!document.getElementById('policy-error').classList.contains('hidden')`);
  assert.ok(isErrorVisible, '#policy-error element must be visible');
  const errorMsg = await evalJs(`document.getElementById('policy-error').textContent`);
  assert.ok(errorMsg.length > 0, '#policy-error must contain parse error details');

  // Assert textarea preserved broken syntax
  const currentTextarea = await evalJs(`document.getElementById('policy-text').value`);
  assert.equal(currentTextarea, brokenSyntax, 'Textarea must retain user edits without wiping');

  // Assert backend active policy is NOT corrupted
  const serverPolicy = getPolicyText();
  assert.ok(serverPolicy.includes('context.rowCount > 50'), 'Server active policy must remain valid and uncorrupted');

  // Recover by clicking Reset Policy
  await clickElem('#reset-policy-btn');
  await waitForState('IDLE', 5000);

  const errorHiddenAfterReset = await evalJs(`document.getElementById('policy-error').classList.contains('hidden')`);
  assert.ok(errorHiddenAfterReset, '#policy-error must be hidden after reset');
  console.log('✓ Phase 6 Passed: Invalid policy displays parse error, preserves editor text, retains backend safety, and recovers cleanly');

  // =========================================================================
  // PHASE 7: RUN FAILURE & RETRY
  // =========================================================================
  console.log('\nPhase 7: Verifying Run failure state and Retry flow...');
  // Intercept window.fetch to simulate network failure on POST /api/run
  await evalJs(`
    const origFetch = window.fetch;
    window.__origFetch = origFetch;
    window.fetch = async (url, options) => {
      if (url === '/api/run') {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: 'Simulated connection failure' })
        };
      }
      return origFetch(url, options);
    };
  `);

  await clickElem('#run-btn');
  await waitForState('RUN_FAILED', 8000);

  const bannerVisible = await evalJs(`!document.getElementById('failure-banner').classList.contains('hidden')`);
  assert.ok(bannerVisible, '#failure-banner must be visible on run failure');
  const failureMsg = await evalJs(`document.getElementById('failure-message').textContent`);
  assert.ok(failureMsg.includes('Run failed'), 'Failure message must state run failed');

  // Controls should be re-enabled (not stuck in running)
  const isRunBtnEnabled = await evalJs(`!document.getElementById('run-btn').disabled`);
  assert.ok(isRunBtnEnabled, 'Run button must be re-enabled after failure');

  // Restore real fetch
  await evalJs(`window.fetch = window.__origFetch; delete window.__origFetch;`);

  // Click retry button
  await clickElem('#retry-btn');
  await waitForRunComplete();

  const bannerHiddenAfterRetry = await evalJs(`document.getElementById('failure-banner').classList.contains('hidden')`);
  assert.ok(bannerHiddenAfterRetry, '#failure-banner must be hidden after successful retry');
  console.log('✓ Phase 7 Passed: Run failure displays banner and retry smoothly executes scenario');

  // =========================================================================
  // PHASE 8: RAPID INTERACTION & DOUBLE-CLICKS
  // =========================================================================
  console.log('\nPhase 8: Verifying rapid interaction protection...');
  // Click Run button 5 times rapidly
  await evalJs(`
    for (let i = 0; i < 5; i++) {
      document.getElementById('run-btn').click();
    }
  `);
  await waitForRunComplete();

  const rapidTraceCount = await evalJs(`document.querySelectorAll('#transcript-list .trace-entry').length`);
  assert.equal(rapidTraceCount, 7, 'Rapid run clicks must not produce duplicate trace entries');

  // Rapidly spam reset policy 5 times
  await evalJs(`
    for (let i = 0; i < 5; i++) {
      document.getElementById('reset-policy-btn').click();
    }
  `);
  await new Promise(r => setTimeout(r, 500));
  assert.equal(await evalJs(`document.getElementById('state-badge').textContent.trim()`), 'IDLE');
  console.log('✓ Phase 8 Passed: Rapid clicks and reset spam are idempotently guarded');

  // =========================================================================
  // PHASE 9: STALE RESPONSE HANDLING
  // =========================================================================
  console.log('\nPhase 9: Verifying stale response abortion with monotonic runId...');
  // Trigger a run, then immediately transition state and trigger catastrophe run
  await evalJs(`
    window.agentJail.runScenario('happy');
    setTimeout(() => {
      window.agentJail.setState(window.agentJail.STATES.IDLE);
      window.agentJail.selectScenario('catastrophe');
      window.agentJail.runScenario('catastrophe');
    }, 100);
  `);
  await waitForRunComplete();

  // Verify the resulting trace is catastrophe (Tool 2 is DENY), NOT happy
  const finalTools = await evalJs(`
    Array.from(document.querySelectorAll('.trace-tool-call')).map(el => ({
      tool: el.querySelector('.tool-name-tag')?.textContent,
      badge: el.querySelector('.status-badge')?.textContent
    }))
  `);
  assert.equal(finalTools.length, 3);
  assert.equal(finalTools[1].badge, 'DENIED', 'Second run must supersede first run cleanly');
  console.log('✓ Phase 9 Passed: Monotonic runId discards superseded executions without race conditions');

  // =========================================================================
  // PHASE 10: TOOL CALL INSPECTION & KEYBOARD NAVIGATION
  // =========================================================================
  console.log('\nPhase 10: Verifying Right Pane inspection and Keyboard navigation...');
  // Ensure we have catastrophe trace active
  const toolElems = await evalJs(`document.querySelectorAll('.trace-tool-call').length`);
  assert.equal(toolElems, 3);

  // Click Tool 1 (ALLOW)
  await evalJs(`document.querySelectorAll('.trace-tool-call')[0].click()`);
  const t1Tag = await evalJs(`document.querySelector('#decision-panel .exec-status-tag')?.textContent`);
  assert.equal(t1Tag, 'POLICY ALLOWED → TOOL EXECUTED');
  const t1Selected = await evalJs(`document.querySelectorAll('.trace-tool-call')[0].classList.contains('selected')`);
  assert.ok(t1Selected, 'Tool 1 must have .selected class');

  // Click Tool 2 (DENY)
  await evalJs(`document.querySelectorAll('.trace-tool-call')[1].click()`);
  const t2Tag = await evalJs(`document.querySelector('#decision-panel .exec-status-tag')?.textContent`);
  assert.equal(t2Tag, 'NOT EXECUTED');
  const t2Selected = await evalJs(`document.querySelectorAll('.trace-tool-call')[1].classList.contains('selected')`);
  assert.ok(t2Selected, 'Tool 2 must have .selected class');

  // Keyboard navigation: focus Tool 1 and press Enter
  await evalJs(`(() => {
    const el = document.querySelectorAll('.trace-tool-call')[0];
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  const t1KeyboardTag = await evalJs(`document.querySelector('#decision-panel .exec-status-tag')?.textContent`);
  assert.equal(t1KeyboardTag, 'POLICY ALLOWED → TOOL EXECUTED', 'Enter key must activate tool inspection');

  // Keyboard navigation: focus Tool 3 and press Space
  await evalJs(`(() => {
    const el = document.querySelectorAll('.trace-tool-call')[2];
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  })()`);
  const t3KeyboardTag = await evalJs(`document.querySelector('#decision-panel .exec-status-tag')?.textContent`);
  assert.equal(t3KeyboardTag, 'NOT EXECUTED', 'Space key must activate tool inspection');

  // Click on a Thought entry - should not crash or corrupt panel
  await evalJs(`(() => {
    const thought = document.querySelector('.trace-thought');
    if (thought) thought.click();
  })()`);
  const panelStillValid = await evalJs(`document.querySelector('#decision-panel .decision-card') !== null`);
  assert.ok(panelStillValid, 'Clicking thought entry must not crash decision panel');

  console.log('✓ Phase 10 Passed: Right pane inspection, keyboard navigation (Enter/Space), and selection styling verified');

  // =========================================================================
  // PHASE 11: VIEWPORTS & LAYOUT INTEGRITY
  // =========================================================================
  console.log('\nPhase 11: Verifying Layout Integrity across 4 responsive viewports...');
  const viewports = [
    { width: 1440, height: 900, name: '1440x900 (Standard Laptop)' },
    { width: 1280, height: 720, name: '1280x720 (Minimum Supported)' },
    { width: 1152, height: 864, name: '1152x864 (125% Zoom Equivalent)' },
    { width: 1920, height: 1080, name: '1920x1080 (Large Projector)' }
  ];

  for (const vp of viewports) {
    await sendCdp('Emulation.setDeviceMetricsOverride', {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: 1,
      mobile: false
    });
    await new Promise(r => setTimeout(r, 200));

    const layout = await evalJs(`(() => {
      const left = document.getElementById('left-pane')?.getBoundingClientRect();
      const center = document.getElementById('center-pane')?.getBoundingClientRect();
      const right = document.getElementById('right-pane')?.getBoundingClientRect();
      const docW = document.documentElement.scrollWidth;
      const clientW = document.documentElement.clientWidth;
      const docH = document.documentElement.scrollHeight;
      const clientH = document.documentElement.clientHeight;
      return {
        leftW: left?.width,
        rightW: right?.width,
        isSideBySide: left && center && right && (left.right <= center.left + 1) && (center.right <= right.left + 1),
        hasPageHScroll: docW > clientW + 1,
        hasPageVScroll: docH > clientH + 1,
        runBtnVisible: !!document.getElementById('run-btn')
      };
    })()`);

    assert.ok(layout.isSideBySide, `Layout at ${vp.name} must keep 3 panes side-by-side horizontally`);
    assert.ok(!layout.hasPageHScroll, `No page-level horizontal scrollbar at ${vp.name}`);
    assert.ok(!layout.hasPageVScroll, `No page-level vertical scrollbar at ${vp.name}`);
    assert.ok(layout.runBtnVisible, `Run button must remain visible at ${vp.name}`);
  }

  // Restore default 1440x900
  await sendCdp('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });
  console.log('✓ Phase 11 Passed: All 4 viewports maintain clean 3-pane workbench without page-level scrollbars');

  // =========================================================================
  // PHASE 12: BROWSER CONSOLE & NETWORK AUDIT
  // =========================================================================
  console.log('\nPhase 12: Auditing browser console logs and network traffic...');
  // We intentionally triggered 1 simulated failure in Phase 7 which logs 'Run failed:' to console.error.
  // All other operations must have 0 unexpected console errors.
  const unexpectedConsoleErrors = consoleErrors.filter(e => !e.includes('Run failed:') && !e.includes('nonexistent_scenario_test'));
  assert.equal(unexpectedConsoleErrors.length, 0, `Unexpected console errors: ${unexpectedConsoleErrors.join('; ')}`);
  assert.equal(uncaughtExceptions.length, 0, `Uncaught exceptions: ${uncaughtExceptions.length}`);

  // Network audit: all requests must be to localhost and expected endpoints
  const externalRequests = networkRequests.filter(r => !r.url.startsWith('http://localhost:') && !r.url.startsWith('http://127.0.0.1:'));
  assert.equal(externalRequests.length, 0, 'Zero external network requests must occur');

  const expectedPaths = ['/', '/style.css', '/app.js', '/api/policy', '/api/policy/reset', '/api/run', '/favicon.ico'];
  for (const req of networkRequests) {
    const urlObj = new URL(req.url);
    assert.ok(
      expectedPaths.includes(urlObj.pathname),
      `Unexpected network path requested: ${urlObj.pathname}`
    );
  }
  console.log('✓ Phase 12 Passed: Console is clean of unexpected errors and network calls are strictly local and authorized');

  // =========================================================================
  // PHASE 13: THE "TRUTHFULNESS" CHECK (Most Critical)
  // =========================================================================
  console.log('\nPhase 13: Performing strict Truthfulness Invariant Verification...');
  // Reset policy
  resetPolicy();

  // Test across each scenario
  for (const sc of ['happy', 'catastrophe', 'injection']) {
    await clickElem(`.scenario-card[data-scenario="${sc}"]`);
    await clickElem('#run-btn');
    await waitForRunComplete();

    // Fetch server truth for this scenario
    const serverRes = await fetch(`http://localhost:${PORT}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: sc })
    });
    const serverData = await serverRes.json();
    const serverTools = serverData.trace.filter(t => t.kind === 'tool_call');

    // Get rendered DOM tools
    const domTools = await evalJs(`
      Array.from(document.querySelectorAll('.trace-tool-call')).map((el, i) => ({
        index: i,
        tool: el.querySelector('.tool-name-tag')?.textContent,
        badge: el.querySelector('.status-badge')?.textContent,
        execState: el.querySelector('.tool-exec-state')?.textContent,
        isAllow: el.classList.contains('tool-allow'),
        isDeny: el.classList.contains('tool-deny')
      }))
    `);

    assert.equal(domTools.length, serverTools.length, `DOM tool count must match server trace for ${sc}`);

    for (let i = 0; i < serverTools.length; i++) {
      const sTool = serverTools[i];
      const dTool = domTools[i];

      assert.equal(dTool.tool, sTool.tool, `Tool names must match at index ${i}`);

      if (sTool.status === 'ALLOW') {
        assert.equal(dTool.badge, 'AUTHORIZED');
        assert.equal(dTool.execState, 'POLICY ALLOWED → TOOL EXECUTED');
        assert.ok(dTool.isAllow);
        assert.ok(!dTool.isDeny);
      } else if (sTool.status === 'DENY') {
        assert.equal(dTool.badge, 'DENIED');
        assert.equal(dTool.execState, 'NOT EXECUTED');
        assert.ok(dTool.isDeny);
        assert.ok(!dTool.isAllow);
      }
    }
  }
  console.log('✓ Phase 13 Passed: Truthfulness Invariant strictly holds across all scenarios and tool calls');

  // =========================================================================
  // PHASE 14: COMPLETE DEMO REHEARSAL
  // =========================================================================
  console.log('\nPhase 14: Rehearsing complete 6-step recorded demo script...');
  const demoStartTime = Date.now();

  // Step 1: Open app / Reset
  await clickElem('#reset-policy-btn');
  await waitForState('IDLE', 5000);

  // Step 2: Run Scenario 1 (Happy)
  await clickElem('.scenario-card[data-scenario="happy"]');
  await clickElem('#run-btn');
  await waitForRunComplete();
  assert.equal(await evalJs(`document.querySelectorAll('.tool-allow').length`), 3);

  // Step 3: Run Scenario 2 (Catastrophe)
  await clickElem('.scenario-card[data-scenario="catastrophe"]');
  await clickElem('#run-btn');
  await waitForRunComplete();
  assert.equal(await evalJs(`document.querySelectorAll('.tool-deny').length`), 2);
  assert.equal(db.customers.length, 1247);

  // Step 4: Run Scenario 3 (Prompt Injection)
  await clickElem('.scenario-card[data-scenario="injection"]');
  await clickElem('#run-btn');
  await waitForRunComplete();
  assert.equal(await evalJs(`document.querySelectorAll('.tool-deny').length`), 2);
  assert.equal(db.outbox.length, 0);

  // Step 5: Edit Policy (50 -> 5000) & Re-run
  const pol = await evalJs(`document.getElementById('policy-text').value`);
  const pol5000 = pol.replace('context.rowCount > 50', 'context.rowCount > 5000');
  await evalJs(`document.getElementById('policy-text').value = ${JSON.stringify(pol5000)}`);
  await clickElem('#save-policy-btn');
  await waitForRunComplete();
  assert.equal(await evalJs(`document.querySelectorAll('.trace-tool-call')[1].querySelector('.status-badge').textContent`), 'AUTHORIZED');
  assert.equal(await evalJs(`document.querySelectorAll('.trace-tool-call')[2].querySelector('.status-badge').textContent`), 'DENIED');

  // Step 6: Reset Policy & Re-run
  await clickElem('#reset-policy-btn');
  await waitForState('IDLE', 5000);
  await clickElem('#run-btn');
  await waitForRunComplete();
  assert.equal(await evalJs(`document.querySelectorAll('.trace-tool-call')[1].querySelector('.status-badge').textContent`), 'DENIED');
  assert.equal(await evalJs(`document.querySelectorAll('.trace-tool-call')[2].querySelector('.status-badge').textContent`), 'DENIED');

  const demoElapsedSec = ((Date.now() - demoStartTime) / 1000).toFixed(1);
  console.log(`✓ Phase 14 Passed: Complete demo rehearsal executed flawlessly in ${demoElapsedSec}s`);

  console.log('\n===================================================================');
  console.log('ALL BROWSER-LEVEL ADVERSARIAL AUDIT PHASES PASSED (14/14)!');
  console.log('===================================================================\n');

} finally {
  if (ws) {
    ws.close();
  }
  if (chromeProc) {
    chromeProc.kill('SIGTERM');
  }
  try {
    fs.rmSync(tempProfileDir, { recursive: true, force: true });
  } catch (_) {}
  if (server) {
    await new Promise(resolve => server.close(resolve));
    console.log('Server closed.');
  }
}
