// Expense utilities — dedupe hashing, CSV parsing, role checks
const crypto = require('crypto');

/**
 * Generate a stable dedupe hash for an expense transaction.
 * Hash = SHA256(company_id + date + amount + description + reference + vendor_name)
 */
function dedupeHash(companyId, date, amount, description, reference, vendorName) {
  const raw = [
    String(companyId),
    String(date || ''),
    String(Math.round((Number(amount) || 0) * 100)), // cents to avoid float issues
    String(description || '').trim().toLowerCase(),
    String(reference || '').trim().toLowerCase(),
    String(vendorName || '').trim().toLowerCase()
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 32);
}

/**
 * Parse CSV text into expense transactions.
 * Supports headers: date, amount, description, vendor, category, cost_center, project, reference, invoice, notes
 */
function parseExpenseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [], errors: [] };

  const parseLine = (line) => {
    const fields = []; let current = ''; let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (inQuotes && line[i+1] === '"') { current += '"'; i++; } else { inQuotes = !inQuotes; } }
      else if (ch === ',' && !inQuotes) { fields.push(current.trim()); current = ''; }
      else { current += ch; }
    }
    fields.push(current.trim());
    return fields;
  };

  const rawHeaders = parseLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, ''));
  const errors = [];
  const rows = [];

  // Map common header variations
  const headerMap = {
    'date': 'date', 'transaction_date': 'date', 'trans_date': 'date', 'posting_date': 'date',
    'amount': 'amount', 'total': 'amount', 'debit': 'amount', 'charge': 'amount', 'cost': 'amount',
    'description': 'description', 'desc': 'description', 'memo': 'description', 'details': 'description', 'name': 'description',
    'vendor': 'vendor_name', 'vendor_name': 'vendor_name', 'payee': 'vendor_name', 'merchant': 'vendor_name', 'supplier': 'vendor_name',
    'category': 'category_name', 'category_name': 'category_name', 'type': 'category_name', 'expense_type': 'category_name',
    'cost_center': 'cost_center_code', 'cost_center_code': 'cost_center_code', 'department': 'cost_center_code', 'dept': 'cost_center_code',
    'project': 'project_name', 'project_name': 'project_name', 'job': 'project_name',
    'reference': 'reference', 'ref': 'reference', 'check_number': 'reference', 'check_no': 'reference', 'transaction_id': 'reference',
    'invoice': 'invoice_number', 'invoice_number': 'invoice_number', 'inv': 'invoice_number',
    'notes': 'notes', 'note': 'notes', 'comment': 'notes'
  };

  const headers = rawHeaders.map(h => headerMap[h] || h);

  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i]);
    if (vals.every(v => !v)) continue; // skip empty rows

    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] || ''; });

    // Validate required fields
    if (!row.date) { errors.push({ line: i + 1, error: 'Missing date' }); continue; }
    if (!row.amount && row.amount !== '0') { errors.push({ line: i + 1, error: 'Missing amount' }); continue; }

    const amount = parseFloat(String(row.amount).replace(/[$,]/g, ''));
    if (isNaN(amount)) { errors.push({ line: i + 1, error: 'Invalid amount: ' + row.amount }); continue; }

    row.amount = amount;
    rows.push(row);
  }

  return { headers, rows, errors };
}

/**
 * Expense role check
 */
const EXPENSE_ROLES = {
  expense_admin: ['create', 'edit', 'delete', 'import', 'approve', 'lock', 'rollback', 'export', 'settings'],
  expense_manager: ['create', 'edit', 'import', 'settings'],
  expense_finance: ['approve', 'lock', 'rollback', 'export'],
  viewer: []
};

function canExpense(user, action) {
  if (user.is_super || user.role === 'admin') return true;
  const roles = user.expense_roles || [];
  return roles.some(r => (EXPENSE_ROLES[r] || []).includes(action));
}

/**
 * Parse CSV into raw rows (no field mapping, no validation).
 * Returns { rawHeaders: string[], dataRows: string[][] }
 */
function parseCSVRaw(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (lines.length < 2) return { rawHeaders: [], dataRows: [] };

  const parseLine = (line) => {
    const fields = []; let current = ''; let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (inQuotes && line[i+1] === '"') { current += '"'; i++; } else { inQuotes = !inQuotes; } }
      else if (ch === ',' && !inQuotes) { fields.push(current.trim()); current = ''; }
      else { current += ch; }
    }
    fields.push(current.trim());
    return fields;
  };

  const rawHeaders = parseLine(lines[0]);
  const dataRows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i]);
    if (vals.every(v => !v)) continue;
    dataRows.push(vals);
  }
  return { rawHeaders, dataRows };
}

/**
 * Auto-suggest column mapping based on header names.
 * Returns { colIndex => targetField } for recognized headers.
 */
function suggestMapping(rawHeaders) {
  const headerMap = {
    'date': 'date', 'transaction_date': 'date', 'trans_date': 'date', 'posting_date': 'date',
    'amount': 'amount', 'total': 'amount', 'debit': 'amount', 'charge': 'amount', 'cost': 'amount',
    'description': 'description', 'desc': 'description', 'memo': 'description', 'details': 'description',
    'vendor': 'vendor_name', 'vendor_name': 'vendor_name', 'payee': 'vendor_name', 'merchant': 'vendor_name', 'supplier': 'vendor_name',
    'category': 'category_name', 'category_name': 'category_name', 'type': 'category_name', 'expense_type': 'category_name',
    'cost_center': 'cost_center_code', 'cost_center_code': 'cost_center_code', 'department': 'cost_center_code', 'dept': 'cost_center_code',
    'project': 'project_name', 'project_name': 'project_name', 'job': 'project_name',
    'reference': 'reference', 'ref': 'reference', 'check_number': 'reference', 'check_no': 'reference', 'transaction_id': 'reference',
    'invoice': 'invoice_number', 'invoice_number': 'invoice_number', 'inv': 'invoice_number',
    'notes': 'notes', 'note': 'notes', 'comment': 'notes', 'name': 'description'
  };

  const mapping = {};
  rawHeaders.forEach((h, i) => {
    const norm = h.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (headerMap[norm]) mapping[i] = headerMap[norm];
  });
  return mapping;
}

module.exports = { dedupeHash, parseExpenseCSV, parseCSVRaw, suggestMapping, canExpense, EXPENSE_ROLES };
