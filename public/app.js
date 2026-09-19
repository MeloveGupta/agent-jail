// Agent Jail Frontend Core Application
// Second Design Pass: Polished Developer / Security Tool Experience
// State machine: IDLE | RUNNING | ANIMATING | COMPLETE | RUN_FAILED | POLICY_INVALID

const STATES = {
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  ANIMATING: 'ANIMATING',
  COMPLETE: 'COMPLETE',
  RUN_FAILED: 'RUN_FAILED',
  POLICY_INVALID: 'POLICY_INVALID'
};

const STEP_ANIMATION_DELAY_MS = 700;

// Application State
const appState = {
  state: STATES.IDLE,
  selectedScenario: 'happy',
  activePolicy: '',
  trace: [],
  revealedCount: 0,
  selectedToolCall: null
};

// DOM Elements
const stateBadge = document.getElementById('state-badge');
const scenarioCards = document.querySelectorAll('.scenario-card');
const runBtn = document.getElementById('run-btn');
const transcriptList = document.getElementById('transcript-list');
const transcriptCount = document.getElementById('transcript-count');
const transcriptPlaceholder = document.getElementById('transcript-placeholder');
const failureBanner = document.getElementById('failure-banner');
const failureMessage = document.getElementById('failure-message');
const retryBtn = document.getElementById('retry-btn');
const decisionPanel = document.getElementById('decision-panel');
const policyTextarea = document.getElementById('policy-text');
const policyError = document.getElementById('policy-error');
const savePolicyBtn = document.getElementById('save-policy-btn');
const resetPolicyBtn = document.getElementById('reset-policy-btn');

// Utility: sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Utility: escape HTML
function escapeHtml(str) {
  if (typeof str !== 'string') return String(str);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// State Management
function setState(newState, details = {}) {
  appState.state = newState;
  
  // Update state badge
  stateBadge.textContent = newState;
  stateBadge.className = `badge badge-state state-${newState.toLowerCase()}`;

  // Update controls based on state
  const isBusy = newState === STATES.RUNNING || newState === STATES.ANIMATING;
  
  runBtn.disabled = isBusy;
  runBtn.textContent = isBusy ? 'Running scenario...' : 'Run Scenario';
  savePolicyBtn.disabled = isBusy;
  resetPolicyBtn.disabled = isBusy;
  policyTextarea.readOnly = isBusy;

  scenarioCards.forEach(card => {
    const input = card.querySelector('input');
    if (input) input.disabled = isBusy;
  });

  if (newState === STATES.POLICY_INVALID) {
    if (details.error) {
      policyError.textContent = details.error;
      policyError.classList.remove('hidden');
    }
  } else {
    policyError.classList.add('hidden');
    policyError.textContent = '';
  }

  if (newState === STATES.RUN_FAILED) {
    if (details.error) {
      failureMessage.textContent = `Run failed: ${details.error}`;
      failureBanner.classList.remove('hidden');
    }
  } else if (newState !== STATES.IDLE) {
    failureBanner.classList.add('hidden');
  }
}

// Fetch Initial Policy on Load (NO AUTO-RUN)
async function loadInitialPolicy() {
  try {
    const res = await fetch('/api/policy');
    if (!res.ok) {
      throw new Error(`Failed to load policy: ${res.statusText}`);
    }
    const data = await res.json();
    appState.activePolicy = data.text || '';
    policyTextarea.value = appState.activePolicy;
    setState(STATES.IDLE);
  } catch (err) {
    console.error('Error fetching initial policy:', err);
    setState(STATES.POLICY_INVALID, { error: err.message });
  }
}

// Scenario Selection
function selectScenario(scenarioId) {
  if (appState.state === STATES.RUNNING || appState.state === STATES.ANIMATING) {
    return;
  }
  appState.selectedScenario = scenarioId;
  scenarioCards.forEach(card => {
    const input = card.querySelector('input');
    if (card.dataset.scenario === scenarioId) {
      card.classList.add('active');
      if (input) input.checked = true;
    } else {
      card.classList.remove('active');
      if (input) input.checked = false;
    }
  });
}

// Render Single Trace Entry for Transcript
function createTraceEntryElement(entry, index) {
  const div = document.createElement('div');
  div.dataset.index = index;

  if (entry.kind === 'thought') {
    div.className = 'trace-entry trace-thought';
    const header = document.createElement('div');
    header.className = 'thought-header';
    
    const label = document.createElement('span');
    label.className = 'thought-label';
    label.textContent = 'AGENT REASONING';
    header.appendChild(label);

    if (entry.scripted) {
      const badge = document.createElement('span');
      badge.className = 'scripted-badge';
      badge.textContent = 'PLANNED STEP · scripted';
      header.appendChild(badge);
    }

    const text = document.createElement('div');
    text.className = 'thought-text';
    text.textContent = entry.text || '';

    div.appendChild(header);
    div.appendChild(text);
  } else if (entry.kind === 'tool_call') {
    const statusLower = (entry.status || 'unknown').toLowerCase();
    div.className = `trace-entry trace-tool-call tool-${statusLower}`;
    
    // Add shake animation on DENY
    if (entry.status === 'DENY') {
      div.classList.add('shake');
    }

    const header = document.createElement('div');
    header.className = 'tool-call-header';

    const nameContainer = document.createElement('div');
    nameContainer.className = 'tool-name-container';

    const name = document.createElement('span');
    name.className = 'tool-name-tag';
    name.textContent = entry.tool;
    nameContainer.appendChild(name);

    // Map status to clean descriptive badge label
    let badgeText = entry.status;
    if (entry.status === 'ALLOW') badgeText = 'AUTHORIZED';
    else if (entry.status === 'DENY') badgeText = 'DENIED';
    else if (entry.status === 'POLICY_ERROR') badgeText = 'POLICY ERROR';
    else if (entry.status === 'UNKNOWN_TOOL') badgeText = 'UNKNOWN TOOL';

    const badge = document.createElement('span');
    badge.className = `status-badge status-${statusLower}`;
    badge.textContent = badgeText;

    header.appendChild(nameContainer);
    header.appendChild(badge);

    const body = document.createElement('div');
    body.className = 'tool-call-body';

    // Tool execution state summary
    const execState = document.createElement('div');
    if (entry.status === 'ALLOW') {
      execState.className = 'tool-exec-state state-allowed';
      execState.textContent = 'POLICY ALLOWED → TOOL EXECUTED';
    } else if (entry.status === 'DENY') {
      execState.className = 'tool-exec-state state-blocked';
      execState.textContent = 'NOT EXECUTED';
    } else if (entry.status === 'POLICY_ERROR') {
      execState.className = 'tool-exec-state state-error';
      execState.textContent = 'NOT EXECUTED (FAIL CLOSED)';
    } else if (entry.status === 'UNKNOWN_TOOL') {
      execState.className = 'tool-exec-state state-unknown';
      execState.textContent = 'NOT EXECUTED (UNKNOWN TOOL)';
    }
    body.appendChild(execState);

    if (entry.explanation) {
      const expl = document.createElement('div');
      expl.className = 'tool-explanation';
      expl.textContent = entry.explanation;
      body.appendChild(expl);
    }

    div.appendChild(header);
    div.appendChild(body);

    div.addEventListener('click', () => {
      document.querySelectorAll('.trace-tool-call').forEach(el => el.classList.remove('selected'));
      div.classList.add('selected');
      renderDecisionPanel(entry);
    });
  } else if (entry.kind === 'done') {
    div.className = 'trace-entry trace-done';
    div.textContent = '— Scenario Execution Complete —';
  }

  return div;
}

// Render Structured Semantic Context Table
function renderContextTable(context) {
  if (!context || typeof context !== 'object' || Object.keys(context).length === 0) {
    return `<div class="empty-context">No semantic context extracted for this tool call</div>`;
  }

  const entries = Object.entries(context);
  const rows = entries.map(([key, val]) => {
    let formattedVal = '';
    let valClass = 'ctx-val';

    if (typeof val === 'boolean') {
      valClass += val ? ' ctx-val-true' : ' ctx-val-false';
      formattedVal = val ? 'true' : 'false';
    } else if (typeof val === 'number') {
      valClass += ' ctx-val-number';
      formattedVal = val.toLocaleString();
    } else if (typeof val === 'string') {
      if (val === 'DELETE' || val === 'DROP' || val === 'TRUNCATE') {
        valClass += ' ctx-val-destructive';
      } else if (val === 'SELECT') {
        valClass += ' ctx-val-select';
      }
      formattedVal = escapeHtml(val);
    } else if (val === null) {
      formattedVal = 'null';
    } else if (typeof val === 'object') {
      formattedVal = escapeHtml(JSON.stringify(val));
    } else {
      formattedVal = escapeHtml(String(val));
    }

    return `
      <tr>
        <td class="ctx-key"><code>${escapeHtml(key)}</code></td>
        <td class="${valClass}"><code>${formattedVal}</code></td>
      </tr>
    `;
  }).join('');

  return `
    <table class="context-table">
      <tbody>
        ${rows}
      </tbody>
    </table>
    <details class="raw-details">
      <summary class="raw-summary">View raw JSON</summary>
      <pre class="code-block">${escapeHtml(JSON.stringify(context, null, 2))}</pre>
    </details>
  `;
}

// Render Structured Tool Arguments Table
function renderArgsTable(args) {
  if (!args || typeof args !== 'object' || Object.keys(args).length === 0) {
    return `<div class="empty-context">No arguments provided</div>`;
  }

  const entries = Object.entries(args);
  const rows = entries.map(([key, val]) => {
    let formattedVal = '';
    if (typeof val === 'object' && val !== null) {
      formattedVal = escapeHtml(JSON.stringify(val));
    } else {
      formattedVal = escapeHtml(String(val));
    }

    return `
      <tr>
        <td class="arg-key"><code>${escapeHtml(key)}</code></td>
        <td class="arg-val"><code>${formattedVal}</code></td>
      </tr>
    `;
  }).join('');

  return `
    <table class="context-table args-table">
      <tbody>
        ${rows}
      </tbody>
    </table>
    <details class="raw-details">
      <summary class="raw-summary">View raw JSON</summary>
      <pre class="code-block">${escapeHtml(JSON.stringify(args, null, 2))}</pre>
    </details>
  `;
}

// Right-Pane: Render Decision & Evidence Panel
function renderDecisionPanel(entry) {
  if (!entry || entry.kind !== 'tool_call') {
    decisionPanel.innerHTML = `
      <div class="decision-placeholder">
        <p>Select a tool call in the transcript to inspect its authorization decision, policy reason, and semantic context evidence.</p>
      </div>
    `;
    return;
  }

  appState.selectedToolCall = entry;

  const statusLower = (entry.status || 'unknown').toLowerCase();
  let statusBadgeLabel = entry.status;
  if (entry.status === 'ALLOW') statusBadgeLabel = 'AUTHORIZED';
  else if (entry.status === 'DENY') statusBadgeLabel = 'DENIED';
  else if (entry.status === 'POLICY_ERROR') statusBadgeLabel = 'POLICY ERROR';
  else if (entry.status === 'UNKNOWN_TOOL') statusBadgeLabel = 'UNKNOWN TOOL';

  // 1. Execution Status Banner
  let execBannerHtml = '';
  if (entry.status === 'DENY') {
    execBannerHtml = `
      <div class="exec-banner exec-banner-deny">
        <div class="exec-badge-row">
          <span class="exec-status-tag tag-not-executed">NOT EXECUTED</span>
          <span class="exec-summary">Action blocked before execution</span>
        </div>
        <p class="exec-desc">
          The authorization decision was <strong>DENY</strong>. The tool call was halted before execution and the underlying database/system was not modified.
        </p>
      </div>
    `;
  } else if (entry.status === 'ALLOW') {
    execBannerHtml = `
      <div class="exec-banner exec-banner-allow">
        <div class="exec-badge-row">
          <span class="exec-status-tag tag-executed">POLICY ALLOWED → TOOL EXECUTED</span>
          <span class="exec-summary">Authorized by Cedar policy</span>
        </div>
        <p class="exec-desc">
          The authorization decision was <strong>ALLOW</strong>. Arguments were validated and the tool was executed by the agent runtime.
        </p>
      </div>
    `;
  } else if (entry.status === 'POLICY_ERROR') {
    execBannerHtml = `
      <div class="exec-banner exec-banner-error">
        <div class="exec-badge-row">
          <span class="exec-status-tag tag-error">NOT EXECUTED (FAIL CLOSED)</span>
          <span class="exec-summary">Authorization engine error</span>
        </div>
        <p class="exec-desc">
          Authorization engine encountered an error while evaluating policy context. In accordance with fail-closed security principles, the tool call was blocked without executing.
        </p>
      </div>
    `;
  } else if (entry.status === 'UNKNOWN_TOOL') {
    execBannerHtml = `
      <div class="exec-banner exec-banner-unknown">
        <div class="exec-badge-row">
          <span class="exec-status-tag tag-unknown">NOT EXECUTED</span>
          <span class="exec-summary">Tool not registered</span>
        </div>
        <p class="exec-desc">
          Planner requested an unregistered tool name. No authorization decision was made and no tool execution occurred.
        </p>
      </div>
    `;
  }

  // 2. Policy Reason Section
  let reasonsHtml = '';
  if (entry.reasons && entry.reasons.length > 0) {
    const isAllow = entry.status === 'ALLOW';
    reasonsHtml = `
      <div class="evidence-block">
        <div class="field-label">${isAllow ? 'Permitting Policy' : 'Policy Reason'}</div>
        <div class="policy-reasons-list">
          ${entry.reasons.map(r => `
            <div class="policy-reason-item">
              <span class="policy-reason-tag ${isAllow ? 'policy-reason-allow' : ''}">${escapeHtml(r)}</span>
              <span class="policy-reason-note">${isAllow ? 'Permitted by active Cedar policy' : 'Forbid policy matched context'}</span>
            </div>
          `).join('')}
        </div>
        ${entry.explanation ? `<div class="tool-explanation">${escapeHtml(entry.explanation)}</div>` : ''}
      </div>
    `;
  } else if (entry.status === 'DENY') {
    reasonsHtml = `
      <div class="evidence-block">
        <div class="field-label">Policy Reason</div>
        <div class="default-deny-box">
          <div class="default-deny-msg">DENY — no policy permits this action (default deny)</div>
          <p class="default-deny-subnote">
            Cedar operates on a strict default-deny model. Because no active permit policy matched this action and context, the request was denied.
          </p>
        </div>
        ${entry.explanation ? `<div class="tool-explanation">${escapeHtml(entry.explanation)}</div>` : ''}
      </div>
    `;
  } else if (entry.status === 'POLICY_ERROR') {
    reasonsHtml = `
      <div class="evidence-block">
        <div class="field-label">Authorization Engine Error</div>
        <div class="policy-error-msg">Fail closed: evaluation failed due to policy runtime error</div>
        ${entry.errors && entry.errors.length > 0 ? `
          <pre class="code-block code-block-error">${escapeHtml(JSON.stringify(entry.errors, null, 2))}</pre>
        ` : ''}
        ${entry.explanation ? `<div class="tool-explanation">${escapeHtml(entry.explanation)}</div>` : ''}
      </div>
    `;
  } else if (entry.status === 'UNKNOWN_TOOL') {
    reasonsHtml = `
      <div class="evidence-block">
        <div class="field-label">Registry Status</div>
        <div class="unknown-tool-msg">Unregistered tool — no policy evaluated</div>
        ${entry.explanation ? `<div class="tool-explanation">${escapeHtml(entry.explanation)}</div>` : ''}
      </div>
    `;
  }

  // 3. Execution Result Section
  let resultHtml = '';
  if (entry.status === 'ALLOW' && entry.result !== null && entry.result !== undefined) {
    resultHtml = `
      <div class="evidence-block">
        <div class="field-label">Tool Execution Result</div>
        <pre class="code-block code-block-result">${escapeHtml(JSON.stringify(entry.result, null, 2))}</pre>
      </div>
    `;
  } else if (entry.status === 'DENY') {
    resultHtml = `
      <div class="evidence-block">
        <div class="field-label">Tool Execution Result</div>
        <div class="result-blocked-note">
          <span class="blocked-glyph">⊘</span>
          <span>No execution output — tool call was denied before invocation.</span>
        </div>
      </div>
    `;
  } else if (entry.status === 'POLICY_ERROR') {
    resultHtml = `
      <div class="evidence-block">
        <div class="field-label">Tool Execution Result</div>
        <div class="result-blocked-note">
          <span class="blocked-glyph" style="color: var(--color-error);">⚠</span>
          <span>No execution output — blocked by fail-closed policy engine error.</span>
        </div>
      </div>
    `;
  } else if (entry.status === 'UNKNOWN_TOOL') {
    resultHtml = `
      <div class="evidence-block">
        <div class="field-label">Tool Execution Result</div>
        <div class="result-blocked-note">
          <span class="blocked-glyph" style="color: var(--color-unknown);">⊘</span>
          <span>No execution output — unregistered tool cannot be executed.</span>
        </div>
      </div>
    `;
  }

  decisionPanel.innerHTML = `
    <div class="decision-card">
      <div class="decision-badge-row">
        <span class="decision-tool-name">${escapeHtml(entry.tool)}</span>
        <span class="status-badge status-${statusLower}">${escapeHtml(statusBadgeLabel)}</span>
      </div>

      ${execBannerHtml}

      ${reasonsHtml}

      <div class="evidence-block">
        <div class="field-label">Semantic Context Evidence</div>
        <span class="section-hint">Derived by runtime inspection of data &amp; arguments before policy check:</span>
        ${renderContextTable(entry.context)}
      </div>

      <div class="evidence-block">
        <div class="field-label">Proposed Arguments</div>
        ${renderArgsTable(entry.args)}
      </div>

      ${resultHtml}
    </div>
  `;
}

// Progressive Trace Animation (~700ms per visible entry)
async function animateTrace(trace) {
  setState(STATES.ANIMATING);
  transcriptList.innerHTML = '';
  appState.revealedCount = 0;
  transcriptCount.textContent = `0 of ${trace.length} entries`;

  for (let i = 0; i < trace.length; i++) {
    if (appState.state !== STATES.ANIMATING) {
      break; // Aborted
    }

    const entry = trace[i];
    const elem = createTraceEntryElement(entry, i);
    transcriptList.appendChild(elem);
    elem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    appState.revealedCount = i + 1;
    transcriptCount.textContent = `${appState.revealedCount} of ${trace.length} entries`;

    // If tool_call, inspect it in the Right Pane immediately
    if (entry.kind === 'tool_call') {
      document.querySelectorAll('.trace-tool-call').forEach(el => el.classList.remove('selected'));
      elem.classList.add('selected');
      renderDecisionPanel(entry);
    }

    // Pacing: approximately 700ms between entries
    if (i < trace.length - 1) {
      await sleep(STEP_ANIMATION_DELAY_MS);
    }
  }

  if (appState.state === STATES.ANIMATING) {
    setState(STATES.COMPLETE);
  }
}

// Execute Scenario Run
async function runScenario(scenarioId) {
  // Prevent duplicate execution while busy
  if (appState.state === STATES.RUNNING || appState.state === STATES.ANIMATING) {
    return;
  }

  setState(STATES.RUNNING);

  // Clear previous transcript
  transcriptList.innerHTML = '';
  transcriptCount.textContent = 'Executing...';
  renderDecisionPanel(null);

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: scenarioId })
    });

    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const errJson = await res.json();
        if (errJson.error) errMsg = errJson.error;
      } catch (_) {}
      throw new Error(errMsg);
    }

    const data = await res.json();
    if (!data.trace || !Array.isArray(data.trace)) {
      throw new Error('Server response did not include a valid trace array');
    }

    appState.trace = data.trace;
    await animateTrace(data.trace);
  } catch (err) {
    console.error('Run failed:', err);
    transcriptList.innerHTML = '';
    transcriptCount.textContent = '0 entries';
    setState(STATES.RUN_FAILED, { error: err.message });
  }
}

// Save Policy & Re-run
async function savePolicyAndRerun() {
  if (appState.state === STATES.RUNNING || appState.state === STATES.ANIMATING) {
    return;
  }

  const text = policyTextarea.value;

  try {
    const res = await fetch('/api/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });

    if (res.status === 400) {
      const errData = await res.json();
      setState(STATES.POLICY_INVALID, { error: errData.error || 'Failed to parse Cedar policy' });
      return;
    }

    if (!res.ok) {
      throw new Error(`Failed to save policy: HTTP ${res.status}`);
    }

    const data = await res.json();
    appState.activePolicy = data.text;
    policyError.classList.add('hidden');
    
    // Save & re-run: re-run the selected scenario
    await runScenario(appState.selectedScenario);
  } catch (err) {
    console.error('Policy save error:', err);
    setState(STATES.POLICY_INVALID, { error: err.message });
  }
}

// Reset Policy (does NOT auto-run)
async function resetPolicy() {
  if (appState.state === STATES.RUNNING || appState.state === STATES.ANIMATING) {
    return;
  }

  try {
    const res = await fetch('/api/policy/reset', {
      method: 'POST'
    });

    if (!res.ok) {
      throw new Error(`Reset failed: HTTP ${res.status}`);
    }

    const data = await res.json();
    appState.activePolicy = data.text;
    policyTextarea.value = data.text;
    policyError.classList.add('hidden');
    setState(STATES.IDLE);
  } catch (err) {
    console.error('Policy reset error:', err);
    alert(`Failed to reset policy: ${err.message}`);
  }
}

// Tab key handling for Cedar policy textarea
policyTextarea.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = policyTextarea.selectionStart;
    const end = policyTextarea.selectionEnd;
    const val = policyTextarea.value;
    policyTextarea.value = val.substring(0, start) + '  ' + val.substring(end);
    policyTextarea.selectionStart = policyTextarea.selectionEnd = start + 2;
  }
});

// Event Listeners
scenarioCards.forEach(card => {
  card.addEventListener('click', () => {
    const scenario = card.dataset.scenario;
    if (scenario) selectScenario(scenario);
  });
});

runBtn.addEventListener('click', () => {
  runScenario(appState.selectedScenario);
});

retryBtn.addEventListener('click', () => {
  runScenario(appState.selectedScenario);
});

savePolicyBtn.addEventListener('click', () => {
  savePolicyAndRerun();
});

resetPolicyBtn.addEventListener('click', () => {
  resetPolicy();
});

// Initialize on page load
loadInitialPolicy();
