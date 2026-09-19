import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SEED_PATH = path.resolve(__dirname, '../data/seed.json');

export const db = {
  customers: [],
  tickets: [],
  outbox: []
};

export function reseed() {
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  db.customers = structuredClone(seed.customers);
  db.tickets = structuredClone(seed.tickets);
  db.outbox = [];
}

// Reseed at module load so the database is never unseeded
reseed();
