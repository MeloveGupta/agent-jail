# Agent Jail

Agent Jail is a local web demo demonstrating a deterministic, general-purpose policy enforcement layer for AI agent tool execution using AWS Cedar. In agentic systems where language models propose multi-step actions against databases and external services, Agent Jail decouples tool proposal from authorization and execution.

## Core Positioning

> "Agent Jail enforces authorization on agent tool calls. Prompt injection is the case where that matters most visibly, because the injected instruction never reaches the component making the decision."

Agent Jail does **NOT** claim to prevent prompt injection. Its purpose is to demonstrate deterministic authorization enforcement on agent tool execution.

### Core Principle

```
MODEL PROPOSES.
POLICY DECIDES.
```

---

## Demo Scenarios

Agent Jail features three deterministic execution scenarios:

### 1. Happy Path (`happy`)
Demonstrates normal authorized agent work.
- **Sequence**:
  1. `search_customers` ("Priya Nair") → **ALLOW** (permitted by `allow-read-customer-data`)
  2. `read_customer` (`c-1024`) → **ALLOW** (permitted by `allow-read-customer-data`)
  3. `send_email` (to `priya@acme.example`) → **ALLOW** (permitted by `allow-email`)
- **Result**: All three steps are authorized, tools execute against the in-memory database, and an order status update email is queued in `db.outbox`.

### 2. The Catastrophe (`catastrophe`)
Demonstrates destructive SQL protection and Cedar's default-deny security model.
- **Sequence**:
  1. `run_sql` (`SELECT count(*) FROM customers WHERE plan='test'`) → **ALLOW** (permitted by `allow-readonly-sql`, returns 312 rows)
  2. `run_sql` (`DELETE FROM customers WHERE plan='test'`) → **DENY** (blocked by `forbid-destructive-sql`, 312 rows protected)
  3. Thought: *"The bulk delete didn't go through. I'll remove the test accounts one at a time instead."*
  4. `delete_customer` (`c-1024`) → **DENY** (blocked by default deny; no active policy permits individual customer deletion)
- **Result**: Neither destructive SQL nor individual deletion executes. The database remains 100% untouched (1,247 customers; 312 test accounts). The third denial explicitly displays: `DENY — no policy permits this action (default deny)`.

### 3. Prompt Injection (`injection`)
Demonstrates authorization enforcement when an untrusted prompt (support ticket T-88) induces the model to propose data exfiltration tools.
- **Sequence**:
  1. `read_tickets` → **ALLOW** (permitted by `allow-read-customer-data`)
  2. `export_customers` (`csv`) → **DENY** (blocked by `forbid-bulk-export`, rowCount: 1,247 > 50)
  3. `send_email` (to untrusted domain `recovery@totally-legit-backups.example`) → **DENY** (blocked by `forbid-email-to-untrusted-domain`)
- **Result**: Neither customer export nor exfiltration email executes. The outbox remains empty. The injected instructions never reach the policy engine.

---

## Live Policy-Edit Demo: Multi-Rule Independence

Agent Jail includes an interactive Cedar policy editor in the right-hand panel, enabling live policy editing during a demonstration:

1. Run the **Prompt Injection** scenario. Notice that `export_customers` is denied because the customers table contains 1,247 rows, exceeding the baseline limit of 50.
2. In the Cedar policy editor (`policies/agent.cedar`), loosen the bulk export limit from `50` to `5000`:
   ```cedar
   @id("forbid-bulk-export")
   forbid (
     principal,
     action == Action::"export_customers",
     resource
   ) when {
     context.rowCount > 5000 // changed from 50
   };
   ```
3. Click **Save & re-run**.
4. Re-running the same injection scenario produces an illuminating result:
   - `export_customers` is now **ALLOWED** and executes (previewing 1,247 rows).
   - `send_email` is **STILL DENIED** by the independent `forbid-email-to-untrusted-domain` policy!

### The Key Insight
> "The policy is a file, not code. I'll loosen the export limit and run the same attack again. Now the export goes through — but the data still doesn't leave, because a second, independent policy governs where it's allowed to go. Two rules, eight lines, and your security team can read both of them."

Changing one authorization rule does not automatically compromise or disable an independent authorization rule. Click **Reset policy** at any time to restore the original policy from disk.

---

## Architecture

Agent Jail decouples agent planning from execution authority:

```
Browser (UI Workbench)
  │
  │  POST /api/run { scenario: "catastrophe" }
  ▼
Express API Server (src/server.js)
  │
  ▼
Mock Brain (src/brain-mock.js)
  │  proposes deterministic plan: [ { thought, tool, args } ]
  ▼
Agent Runtime (src/agent.js)
  │
  ├─► Reseeds in-memory database (data/seed.json)
  │
  ├─► For each step:
  │     1. Context Builder (src/context.js)
  │        Inspects tool arguments & database state to derive semantic context
  │     2. Cedar Authorization Layer (src/cedar.js)
  │        Evaluates request via @cedar-policy/cedar-wasm
  │     3. Execution Guard
  │        • ALLOW: Validates arguments & executes tool (src/tools.js)
  │        • DENY: Halts invocation; records context evidence
  │
  └─► Returns complete trace array: HTTP 200 { trace: [...] }
  │
  ▼
Browser Animation (public/app.js)
  Reveals trace entries sequentially (~700ms pacing)
  Inspects authorization decisions and structured context in real time
```

### Architectural Guarantees
- **Server Authority**: All Cedar evaluations and tool executions occur strictly on the server.
- **Safe Frontend**: The frontend never evaluates Cedar, executes tools, or mutates data.
- **Synchronous Trace**: `POST /api/run` returns the complete execution trace. The frontend renders it progressively (no WebSockets, SSE, or polling).

---

## AWS & Cedar Policy Engine

Agent Jail uses AWS Cedar via `@cedar-policy/cedar-wasm/nodejs` for sub-millisecond authorization evaluation:

- **Principal**: `Agent::"support-bot"`
- **Actions**: `Action::"search_customers"`, `Action::"read_customer"`, `Action::"read_tickets"`, `Action::"run_sql"`, `Action::"export_customers"`, `Action::"send_email"`, `Action::"issue_refund"`, `Action::"delete_customer"`
- **Resource**: `System::"acme-prod"`
- **Context**: Dynamic semantic evidence derived at runtime (e.g. `sqlOperation`, `rowsAffected`, `table`, `rowCount`, `trusted`, `recipientDomain`).
- **Authorization Semantics**:
  - A request must be explicitly permitted by a `permit` policy.
  - An explicit `forbid` policy unconditionally overrides permits.
  - Any request without a matching `permit` policy is denied by **default deny**.
  - Any policy engine or context evaluation error **fails closed** (`POLICY_ERROR`), preventing execution.

> **Note on Amazon Bedrock**: The recorded demo operates deterministically using `BRAIN=mock`. Amazon Bedrock LLM integration is architectural future work.

---

## Security & Threat Model Boundary

In an agentic workflow, language models are **untrusted planners**. 

- The model proposes tools and parameters.
- The policy enforcement layer sits between the model brain and actual tool execution.
- Tool execution is blocked before invocation unless Cedar explicitly authorizes the action based on verified context.

Agent Jail demonstrates this boundary. It does not claim that Cedar alone secures an entire production agent deployment or solves every prompt injection vector; rather, it guarantees that untrusted model instructions cannot bypass deterministic authorization policies.

---

## Local Setup

### Prerequisites
- **Node.js** 20.0.0 or higher
- **npm** 9.0.0 or higher

### Installation
```bash
git clone https://github.com/MeloveGupta/agent-jail.git
cd AgentJail
npm install
```

### Running the Application
```bash
npm start
```
By default, the server starts at `http://localhost:3001` with `BRAIN=mock`.

### Environment Configuration
The port and brain mode can be configured via environment variables:
```bash
PORT=3001 BRAIN=mock npm start
```

---

## Testing

Run the full automated test suite:
```bash
npm test
```

### Test Coverage (57/57 Passing)
- **Cedar Foundation** (`test/verify-cedar.js` - 14 tests): Cedar WASM policy parsing, permit/forbid rules, default deny, and fail-closed evaluation.
- **Runtime Execution** (`test/verify-runtime.js` - 16 tests): Plan execution, semantic context extraction, argument validation, and database safety invariants.
- **Server API** (`test/verify-server.js` - 17 tests): Express endpoints (`GET /api/policy`, `POST /api/policy`, `POST /api/policy/reset`, `POST /api/run`), error propagation, and HTTP 400 rejection on invalid Cedar.
- **Frontend Core** (`test/verify-frontend.js` - 5 tests): Static asset serving, 3-column workbench dimensions (`260px | 1fr | 440px`), 15px base font size, state machine contracts, and exact positioning statement.
- **End-to-End Integration** (`test/verify-integration.js` - 5 tests): Database isolation across sequential runs, live demo policy edit & multi-rule independence, trace schema contract, API failure propagation, and mock brain determinism.

---

## Hackathon Demo Runbook

Follow these steps for a presentation or video recording:

1. **Start the Application**:
   ```bash
   BRAIN=mock npm start
   ```
2. **Open Browser**: Navigate to `http://localhost:3001`. Confirm the status badge reads `IDLE` and no scenario auto-runs.
3. **Core Pitch**: Explain:
   > *"The model proposes. The policy decides."*
   > *"Agent Jail enforces authorization on agent tool calls. Prompt injection is the case where that matters most visibly, because the injected instruction never reaches the component making the decision."*
4. **Run Scenario A (Happy Path)**:
   - Select **Happy path** and click **Run Scenario**.
   - Observe 3 planned steps, 3 authorized tool calls, and the queued customer email.
5. **Run Scenario B (The Catastrophe)**:
   - Select **The catastrophe** and click **Run Scenario**.
   - Observe `SELECT count(*)` allowed, followed by `DELETE FROM customers` denied by `forbid-destructive-sql` (312 rows protected).
   - Observe agent replanning to delete Priya Nair individually, which is blocked by **default deny**.
   - Emphasize: The database remained 100% protected.
6. **Run Scenario C (Prompt Injection)**:
   - Select **Prompt injection** and click **Run Scenario**.
   - Observe open ticket lookup allowed, but the bulk customer export is blocked by `forbid-bulk-export`, and the exfiltration email is blocked by `forbid-email-to-untrusted-domain`.
7. **Execute Policy-Edit Beat**:
   - In the right-pane policy editor, edit `forbid-bulk-export` threshold: change `50` to `5000`.
   - Click **Save & re-run**.
   - Point out that the export now executes successfully, but the exfiltration email is **still blocked** by the independent untrusted domain policy.
8. **Reset Policy**:
   - Click **Reset policy** to restore the baseline policy (threshold 50).

---

## Current Limitations

- **Deterministic Mock Brain**: Uses deterministic, scripted scenarios for reproducible demos.
- **Future Bedrock Integration**: Direct LLM / Amazon Bedrock planning is decoupled and planned as future work.
- **In-Memory Database**: Reseeded from `data/seed.json` on each scenario run; no persistent SQL database is used.
- **Local Web Application**: No multi-tenant authentication, user management, or session cookies.
- **Scope**: Designed specifically to demonstrate authorization enforcement on proposed tool calls, not automated prompt sanitization.

---

## Deployment Readiness

- **Node.js 20+ Runtime**: Pure ECMAScript modules (ESM) without build steps, bundlers, or transpilation.
- **Port Binding**: Supports the `PORT` environment variable (defaults to `3001`).
- **Self-Contained**: Static frontend files are served directly by Express from `/public`. Zero external database, Redis, or cloud service dependencies are required for local or containerized execution.
