// Agent Jail Frontend Core Application
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
  selectedToolCall: null,
  animationAbortController: null
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

// State Management
function setState(newState, details = {}) {
  appState.state = newState;
  
  // Update state badge
  stateBadge.textContent = newState;
  stateBadge.className = `badge badge-state state-${newState.toLowerCase()}`;

  // Update controls based on state
  const isBusy = newState === STATES.RUNNING || newState === STATES.ANIMATING;
  
  runBtn.disabled = isBusy;
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

// Render Single Trace Entry
function createTraceEntryElement(entry, index) {
  const div = document.createElement('div');
  div.dataset.index = index;

  if (entry.kind === 'thought') {
    div.className = 'trace-entry trace-thought';
    const header = document.createElement('div');
    header.className = 'thought-header';
    
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
    const statusClass = `tool-${(entry.status || 'unknown').toLowerCase()}`;
    div.className = `trace-entry trace-tool-call ${statusClass}`;
    
    // Add shake animation on DENY
    if (entry.status === 'DENY') {
      div.classList.add('shake');
    }

    const header = document.createElement('div');
    header.className = 'tool-call-header';

    const name = document.createElement('span');
    name.className = 'tool-name-tag';
    name.textContent = entry.tool;

    const badge = document.createElement('span');
    badge.className = `status-badge status-${(entry.status || '').toLowerCase()}`;
    badge.textContent = entry.status;

    header.appendChild(name);
    header.appendChild(badge);

    const body = document.createElement('div');
    body.className = 'tool-call-body';

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

// Right-Pane: Render Decision & Evidence Panel
function renderDecisionPanel(entry) {
  if (!entry || entry.kind !== 'tool_call') {
    decisionPanel.innerHTML = `
      <div class="decision-placeholder">
        <p>Select a tool call in the transcript to inspect its authorization decision and semantic context.</p>
      </div>
    `;
    return;
  }

  appState.selectedToolCall = entry;

  let reasonsHtml = '';
  if (entry.reasons && entry.reasons.length > 0) {
    reasonsHtml = `
      <div>
        <div class="field-label">Policy Reason</div>
        <div class="policy-reasons-list">
          ${entry.reasons.map(r => `<span class="policy-reason-tag">${escapeHtml(r)}</span>`).join('')}
        </div>
      </div>
    `;
  } else if (entry.status === 'DENY') {
    reasonsHtml = `
      <div>
        <div class="field-label">Policy Reason</div>
        <div class="default-deny-msg">DENY — no policy permits this action (default deny)</div>
      </div>
    `;
  }

  let resultHtml = '';
  if (entry.result !== null && entry.result !== undefined) {
    resultHtml = `
      <div>
        <div class="field-label">Tool Result</div>
        <pre class="code-block">${escapeHtml(JSON.stringify(entry.result, null, 2))}</pre>
      </div>
    `;
  }

  let errorsHtml = '';
  if (entry.errors && entry.errors.length > 0) {
    errorsHtml = `
      <div>
        <div class="field-label">Errors</div>
        <pre class="code-block" style="color: #ff7b72;">${escapeHtml(JSON.stringify(entry.errors, null, 2))}</pre>
      </div>
    `;
  }

  decisionPanel.innerHTML = `
    <div class="decision-card">
      <div class="decision-badge-row">
        <span class="decision-tool-name">${escapeHtml(entry.tool)}</span>
        <span class="status-badge status-${(entry.status || '').toLowerCase()}">${escapeHtml(entry.status)}</span>
      </div>

      <div>
        <div class="field-label">Decision</div>
        <div style="font-family: var(--font-mono); font-size: 14px; font-weight: 600;">
          ${escapeHtml(entry.decision || 'n/a')}
        </div>
      </div>

      ${reasonsHtml}

      <div>
        <div class="field-label">Semantic Context</div>
        <pre class="code-block">${escapeHtml(JSON.stringify(entry.context || {}, null, 2))}</pre>
      </div>

      <div>
        <div class="field-label">Tool Arguments</div>
        <pre class="code-block">${escapeHtml(JSON.stringify(entry.args || {}, null, 2))}</pre>
      </div>

      ${resultHtml}
      ${errorsHtml}
    </div>
  `;
}

function escapeHtml(str) {
  if (typeof str !== 'string') return String(str);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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

    // If tool_call, inspect it in the Right Pane
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
