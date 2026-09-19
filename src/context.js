import { db } from './db.js';

export const TRUSTED_DOMAINS = [
  'acme.example',
  'acme-support.example'
];

export function countMatching(sql) {
  const m = sql.match(/WHERE\s+(\w+)\s*=\s*'([^']*)'/i);

  if (!m) return db.customers.length;

  const [, field, value] = m;

  return db.customers.filter(
    c => String(c[field]) === value
  ).length;
}

export function buildContext(tool, args = {}) {
  switch (tool) {
    case 'run_sql': {
      const sql = String(args?.query || '');
      const op = (sql.trim().split(/\s+/)[0] || '').toUpperCase();

      const operation = [
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'DROP',
        'TRUNCATE',
        'ALTER'
      ].includes(op)
        ? op
        : 'UNKNOWN';

      return {
        sqlOperation: operation,
        rowsAffected: operation === 'SELECT' ? 0 : countMatching(sql),
        table:
          (sql.match(/FROM\s+(\w+)|INTO\s+(\w+)|TABLE\s+(\w+)/i) || [])
            .slice(1)
            .find(Boolean) || 'unknown'
      };
    }

    case 'send_email': {
      const to = String(args?.to || '');
      const domain = to.split('@')[1] || '';
      return {
        recipientDomain: domain,
        recipientIsKnownCustomer: db.customers.some(c => c.email === to),
        trusted: TRUSTED_DOMAINS.includes(domain)
      };
    }

    case 'export_customers': {
      return {
        rowCount: db.customers.length,
        format: String(args?.format || 'json')
      };
    }

    case 'issue_refund': {
      return {
        amountRupees: Number(args?.amount) || 0
      };
    }

    case 'read_customer':
    case 'search_customers':
    case 'read_tickets':
    case 'delete_customer':
    default: {
      return {};
    }
  }
}
