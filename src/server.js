import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from './agent.js';
import { brainMock } from './brain-mock.js';
import { getPolicyText, setPolicyText, resetPolicy } from './cedar.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../public');

const PORT = parseInt(process.env.PORT, 10) || 3001;
const brainMode = (process.env.BRAIN || 'mock').toLowerCase();

let brain;
if (brainMode === 'mock') {
  brain = brainMock;
} else {
  // Default to mock
  brain = brainMock;
}

const app = express();

// Serve static frontend assets from /public
app.use(express.static(PUBLIC_DIR));

// Parse JSON request bodies
app.use(express.json());

// Handle malformed JSON
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Malformed JSON payload' });
  }
  next(err);
});

// GET /api/policy - Returns active policy text
app.get('/api/policy', (req, res) => {
  res.json({ text: getPolicyText() });
});

// POST /api/policy - Parses and updates active policy text
app.post('/api/policy', (req, res) => {
  const text = req.body?.text;
  if (typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid policy text' });
  }

  try {
    setPolicyText(text);
    res.json({ text: getPolicyText() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/policy/reset - Restores policy from policies/agent.cedar
app.post('/api/policy/reset', (req, res) => {
  try {
    resetPolicy();
    res.json({ text: getPolicyText() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Supported scenario IDs
const SUPPORTED_SCENARIOS = ['happy', 'catastrophe', 'injection'];

// POST /api/run - Executes agent scenario and returns full trace
app.post('/api/run', async (req, res, next) => {
  const scenario = req.body?.scenario;
  if (!scenario || !SUPPORTED_SCENARIOS.includes(scenario)) {
    return res.status(400).json({
      error: `Unknown scenario: ${scenario || 'undefined'}`
    });
  }

  try {
    const trace = await runAgent(scenario, brain);
    res.json({ trace });
  } catch (err) {
    next(err);
  }
});

// Generic error handler (clean JSON response without exposing raw stack traces)
app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

let server;
if (process.env.NODE_ENV !== 'test_no_listen') {
  server = app.listen(PORT, () => {
    console.log(`Agent Jail running on http://localhost:${PORT}`);
    console.log(`Brain: ${brainMode}`);
  });
}

export { app, server, PORT, brainMode };
export default app;
