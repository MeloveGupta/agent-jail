import { db } from './db.js';
import { countMatching } from './context.js';

const REQUIRED = {
  send_email: ['to', 'subject'],
  read_customer: ['id'],
  search_customers: ['query'],
  run_sql: ['query'],
  issue_refund: ['customer_id', 'amount'],
  delete_customer: ['id'],
  export_customers: [],
  read_tickets: []
};

export function validateArgs(tool, args) {
  const missing = (REQUIRED[tool] || [])
    .filter(k => args?.[k] === undefined || args[k] === '');

  return missing.length
    ? `missing required field(s): ${missing.join(', ')}`
    : null;
}

export const TOOLS = {
  send_email: {
    run: async (args) => {
      const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      db.outbox.push({
        ...args,
        id
      });
      return {
        queued: true,
        messageId: id
      };
    }
  },

  export_customers: {
    run: async (_args) => {
      const header = 'id,name,email,plan';
      const previewRows = db.customers
        .slice(0, 3)
        .map(c => `${c.id},${c.name},${c.email},${c.plan}`);
      return {
        rows: db.customers.length,
        csvPreview: [header, ...previewRows].join('\n'),
        truncated: `... ${db.customers.length - 3} more rows`
      };
    }
  },

  run_sql: {
    run: async (args) => {
      const sql = String(args?.query || '');
      if (!sql.trim().toUpperCase().startsWith('SELECT')) {
        throw new Error('Only SELECT operations are supported');
      }
      return {
        count: countMatching(sql)
      };
    }
  },

  read_customer: {
    run: async (args) => {
      const customer = db.customers.find(c => c.id === args?.id);
      if (!customer) {
        return { error: 'not found' };
      }
      return customer;
    }
  },

  search_customers: {
    run: async (args) => {
      const q = String(args?.query || '').toLowerCase();
      return db.customers
        .filter(c =>
          (c.name && c.name.toLowerCase().includes(q)) ||
          (c.email && c.email.toLowerCase().includes(q)) ||
          (c.id && c.id.toLowerCase().includes(q))
        )
        .slice(0, 5);
    }
  },

  read_tickets: {
    run: async (_args) => {
      return db.tickets;
    }
  },

  issue_refund: {
    run: async (args) => {
      return {
        refunded: true,
        amount: args?.amount
      };
    }
  },

  delete_customer: {
    run: async (args) => {
      const idx = db.customers.findIndex(c => c.id === args?.id);
      if (idx !== -1) {
        db.customers.splice(idx, 1);
        return { deleted: true, id: args.id };
      }
      return { deleted: false, error: 'not found' };
    }
  }
};
