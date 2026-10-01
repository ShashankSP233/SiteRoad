'use strict';
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
require('./env');

// pg returns BIGINT (and NUMERIC) columns as strings by default, because a
// 64-bit value can exceed what a JS number can represent exactly. Every
// BIGINT column in this schema is either an epoch-millisecond timestamp or
// a paise amount -- both comfortably inside Number.MAX_SAFE_INTEGER -- so it's
// safe (and much less error-prone than auditing every call site) to parse
// them as ordinary numbers globally.
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10))); // BIGINT

if (!process.env.SITEROAD_DATABASE_URL) {
  throw new Error('Set SITEROAD_DATABASE_URL before starting SiteRoad');
}

const pool = new Pool({
  connectionString: process.env.SITEROAD_DATABASE_URL,
  
  // Managed Postgres hosts (Supabase, Render, Railway, Neon, ...) require
  // SSL and use certs not in Node's default trust store; local/Docker
  // Postgres usually has none. Auto-detect by host, override with PGSSL.
  ssl: process.env.PGSSL === '0' ? false
     : process.env.PGSSL === '1' ? { rejectUnauthorized: false }
     : /localhost|127\.0\.0\.1/.test(process.env.SITEROAD_DATABASE_URL || "localhost") ? false
     : { rejectUnauthorized: false },
});
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

const uid = () => crypto.randomUUID();
const now = () => Date.now();

// Money is stored as BIGINT paise (Rs.1 = 100) everywhere in the database to
// avoid floating-point rounding drift in sums/balances. The API boundary
// still speaks rupees (decimal) in both directions -- these two helpers are
// the only place that conversion happens, so nothing upstream needs to
// know paise exists.
const toPaise = (rupees) => Math.round(Number(rupees) * 100);
const toRupees = (paise) => Math.round(Number(paise) || 0) / 100;

// ---------------------------------------------------------------- compatibility shim
// api.js was written against better-sqlite3's synchronous db.prepare(sql).get/all/run()
// API. Rather than rewrite ~150 call sites' SQL text, this shim keeps the same
// `?`-placeholder SQL strings and the same .get/.all/.run shape, just made async
// (Postgres has no synchronous driver -- every query is a real network round trip).
//
// Transactions: a pool hands out one of several connections per query, but every
// statement in a transaction must run on the SAME connection. AsyncLocalStorage
// tracks "the current transaction's client, if any" so that nested helper
// functions (addHistory, logAudit, nextVoucher, ...) calling db.prepare(...) from
// inside a db.transaction() callback automatically join that same transaction
// without needing a client threaded through every function signature.
const txContext = new AsyncLocalStorage();

function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

async function raw(sql, params) {
  const client = txContext.getStore();
  return client ? client.query(sql, params) : pool.query(sql, params);
}

function prepare(sql) {
  const pgSql = toPgSql(sql);
  return {
    get: async (...params) => {
      const r = await raw(pgSql, params.flat());
      return r.rows[0];
    },
    all: async (...params) => {
      const r = await raw(pgSql, params.flat());
      return r.rows;
    },
    run: async (...params) => {
      const r = await raw(pgSql, params.flat());
      return { changes: r.rowCount };
    },
  };
}

async function exec(sql) {
  const client = txContext.getStore();
  if (client) return client.query(sql);
  return pool.query(sql);
}

// Runs fn inside BEGIN/COMMIT (ROLLBACK on throw) on a single dedicated
// connection. If already inside a transaction (nested call, e.g. nextVoucher()
// called from within the POST /expenses handler's own transaction), reuses the
// same connection instead of starting a new one -- mirroring better-sqlite3's
// automatic transaction nesting.
async function transaction(fn) {
  const existing = txContext.getStore();
  if (existing) return fn();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await txContext.run(client, fn);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

const db = { prepare, exec, transaction };

// ---------------------------------------------------------------- schema (fresh installs)
async function initSchema() {
  await exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  all_projects INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS user_projects (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY (user_id, project_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  voucher_no TEXT NOT NULL,
  date TEXT NOT NULL,
  amount BIGINT NOT NULL,
  category_id TEXT,
  details TEXT,
  project_id TEXT NOT NULL,
  location_id TEXT,
  site_user_id TEXT,
  voucher_printed_at BIGINT,
  voucher_printed_by TEXT,
  expense_done_by TEXT,
  bill_received TEXT,
  bill_no TEXT,
  payment_status TEXT,
  remark TEXT,
  status TEXT NOT NULL,
  prev_status TEXT,
  approvals TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  submitted_at BIGINT,
  paid INTEGER DEFAULT 0,
  paid_at TEXT,
  paid_by TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (voucher_printed_by) REFERENCES users(id) ON DELETE RESTRICT
);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS site_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS voucher_printed_at BIGINT;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS voucher_printed_by TEXT REFERENCES users(id) ON DELETE RESTRICT;
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  original_name TEXT,
  mime TEXT,
  FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS expense_history (
  id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL,
  by_user TEXT,
  action TEXT,
  detail TEXT,
  at BIGINT NOT NULL,
  FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE,
  FOREIGN KEY (by_user) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS funds (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  amount BIGINT NOT NULL,
  date TEXT NOT NULL,
  note TEXT,
  added_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'injection',
  to_user TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (to_user) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS fund_requests (
  id TEXT PRIMARY KEY,
  request_no TEXT UNIQUE NOT NULL,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Requested',
  total_amount BIGINT NOT NULL DEFAULT 0,
  printed_at BIGINT,
  printed_by TEXT,
  released_at BIGINT,
  released_by TEXT,
  site_user_id TEXT,
  receipt_confirmed_at BIGINT,
  receipt_confirmed_by TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (printed_by) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (released_by) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (receipt_confirmed_by) REFERENCES users(id) ON DELETE RESTRICT
);

ALTER TABLE fund_requests ADD COLUMN IF NOT EXISTS site_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE fund_requests ADD COLUMN IF NOT EXISTS receipt_confirmed_at BIGINT;
ALTER TABLE fund_requests ADD COLUMN IF NOT EXISTS receipt_confirmed_by TEXT REFERENCES users(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS fund_request_items (
  id TEXT PRIMARY KEY,
  fund_request_id TEXT NOT NULL,
  expense_id TEXT NOT NULL,
  amount BIGINT NOT NULL,
  FOREIGN KEY (fund_request_id)
    REFERENCES fund_requests(id)
    ON DELETE CASCADE,
  FOREIGN KEY (expense_id)
    REFERENCES expenses(id)
    ON DELETE RESTRICT,
  UNIQUE(fund_request_id, expense_id)
);

CREATE INDEX IF NOT EXISTS idx_fund_requests_status
  ON fund_requests(status);

CREATE INDEX IF NOT EXISTS idx_fund_requests_created_by
  ON fund_requests(created_by);

CREATE INDEX IF NOT EXISTS idx_fund_request_items_request
  ON fund_request_items(fund_request_id);

CREATE INDEX IF NOT EXISTS idx_fund_request_items_expense
  ON fund_request_items(expense_id);

CREATE TABLE IF NOT EXISTS queries (
  id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL,
  voucher_no TEXT,
  raised_by TEXT NOT NULL,
  assigned_to TEXT NOT NULL,
  text TEXT,
  status TEXT NOT NULL,
  prev_status TEXT,
  created_at BIGINT NOT NULL,
  resolved_at BIGINT,
  FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE,
  FOREIGN KEY (raised_by) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS query_messages (
  id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL,
  by_user TEXT,
  text TEXT,
  at BIGINT NOT NULL,
  FOREIGN KEY (query_id) REFERENCES queries(id) ON DELETE CASCADE,
  FOREIGN KEY (by_user) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  at BIGINT NOT NULL,
  user_id TEXT, user_name TEXT, role TEXT,
  action TEXT, entity TEXT, entity_id TEXT, detail TEXT
);
CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY, seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_budgets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  period TEXT NOT NULL,
  budget_amount BIGINT NOT NULL,
  created_by TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(project_id, period),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exp_project  ON expenses(project_id);
CREATE INDEX IF NOT EXISTS idx_exp_creator  ON expenses(created_by);
CREATE INDEX IF NOT EXISTS idx_exp_status   ON expenses(status);
CREATE INDEX IF NOT EXISTS idx_funds_proj   ON funds(project_id);
CREATE INDEX IF NOT EXISTS idx_funds_touser ON funds(to_user);
CREATE INDEX IF NOT EXISTS idx_evidence_exp ON evidence(expense_id);
CREATE INDEX IF NOT EXISTS idx_history_exp  ON expense_history(expense_id);
CREATE INDEX IF NOT EXISTS idx_queries_exp  ON queries(expense_id);
CREATE INDEX IF NOT EXISTS idx_budgets_proj ON project_budgets(project_id);
UPDATE users SET role = CASE role
  WHEN 'site' THEN 'site_accounts'
  WHEN 'checker' THEN 'general_manager'
  WHEN 'purchase' THEN 'project_director'
  WHEN 'operations' THEN 'senior_accountant'
  WHEN 'accounts' THEN 'accounts_manager'
  ELSE role
END
WHERE role IN ('site','checker','purchase','operations','accounts');
UPDATE expenses e
SET site_user_id = e.created_by
FROM users u
WHERE e.created_by = u.id
  AND u.role = 'site_accounts'
  AND e.site_user_id IS NULL;
UPDATE fund_requests fr
SET site_user_id = owners.site_user_id
FROM (
  SELECT fri.fund_request_id,
         MIN(COALESCE(e.site_user_id, e.created_by)) AS site_user_id
  FROM fund_request_items fri
  JOIN expenses e ON e.id = fri.expense_id
  GROUP BY fri.fund_request_id
  HAVING COUNT(DISTINCT COALESCE(e.site_user_id, e.created_by)) = 1
) owners
WHERE fr.id = owners.fund_request_id
  AND fr.site_user_id IS NULL;
-- Retire the former separate receipt-confirmation profile. Site Accounts users
-- now confirm their own assigned fund requests.
UPDATE users SET active=0 WHERE role='site_accountant' AND active<>0;
`);
}

// ---------------------------------------------------------------- seed
async function seed() {
  const seeded = await db.prepare('SELECT 1 FROM users LIMIT 1').get();
  if (seeded) return;

  const insProj = db.prepare('INSERT INTO projects (id,code,name,active) VALUES (?,?,?,1)');
  const projects = [
    ['p_dm', 'DM', 'Digha Majhaua'],
    ['p_mg', 'MG', 'Majhaua Gazipur'],
    ['p_kg', 'KG', 'Kalughat'],
    ['p_as', 'ASM', 'Assam'],
  ];
  for (const p of projects) await insProj.run(p[0], p[1], p[2]);

  const insCat = db.prepare('INSERT INTO categories (id,name,active) VALUES (?,?,1)');
  for (const n of ['Food', 'Fuel', 'Spare without GST', 'LPG', 'Maintenance', 'Transportation', 'Water', 'Spare', 'Miscellaneous'])
    await insCat.run(uid(), n);

  const insLoc = db.prepare('INSERT INTO locations (id,name,active) VALUES (?,?,1)');
  for (const n of ['Patna - RO', 'Arra - RO', 'Dharti - 3', 'APS-16', 'APS-15', 'Sharda', 'Kalughat', 'Guest House'])
    await insLoc.run(uid(), n);

  const insUser = db.prepare(
    'INSERT INTO users (id,username,name,password_hash,role,all_projects,active,created_at) VALUES (?,?,?,?,?,?,1,?)'
  );
  const insUP = db.prepare('INSERT INTO user_projects (user_id,project_id) VALUES (?,?)');
  const mk = async (id, un, nm, pw, role, all, projIds) => {
    await insUser.run(id, un, nm, bcrypt.hashSync(pw, 10), role, all ? 1 : 0, now());
    if (!all) for (const pid of (projIds || [])) await insUP.run(id, pid);
  };
  await mk('u_admin', 'admin', 'System Admin', 'admin123', 'admin', true);
  await mk('u_site', 'site', 'Suresh Chand (Site)', 'site123', 'site_accounts', false, ['p_dm', 'p_mg']);
  await mk('u_check', 'general_manager', 'Vipul (General Manager)', 'check123', 'general_manager', true);
  await mk('u_pur', 'project_director', 'Amrit (Project Director)', 'pur123', 'project_director', true);
  await mk('u_ops', 'senior_accountant', 'Senior Accountant', 'ops123', 'senior_accountant', true);
  await mk('u_acc', 'accounts_manager', 'Accounts Manager', 'acc123', 'accounts_manager', true);

  await db.prepare("INSERT INTO counters (name,seq) VALUES ('voucher',1000)").run();
  console.log('[db] seeded demo data with SiteRoad roles');
}

// ---------------------------------------------------------------- helpers
async function loadUser(id) {
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return null;
  u.all_projects = !!u.all_projects;
  u.active = !!u.active;
  u.project_ids = (await db.prepare('SELECT project_id FROM user_projects WHERE user_id=?').all(id)).map((r) => r.project_id);
  return u;
}

function scopeOf(user) {
  if (user.all_projects || user.role === 'admin') return { all: true, ids: [] };
  return { all: false, ids: user.project_ids };
}

async function nextVoucher() {
  return 'VCH-' + (await db.transaction(async () => {
    const c = await db.prepare("SELECT seq FROM counters WHERE name='voucher'").get();
    const next = (c ? c.seq : 1000) + 1;
    await db.prepare("UPDATE counters SET seq=? WHERE name='voucher'").run(next);
    return next;
  }));
}

async function nextFundRequest() {
  const c = await db.prepare(
    "SELECT seq FROM counters WHERE name='fund_request'"
  ).get();

  const next = (c ? c.seq : 0) + 1;

  if (c) {
    await db.prepare(
      "UPDATE counters SET seq=? WHERE name='fund_request'"
    ).run(next);
  } else {
    await db.prepare(
      "INSERT INTO counters (name, seq) VALUES ('fund_request', ?)"
    ).run(next);
  }

  return 'FR-' + String(next).padStart(4, '0');
}

async function logAudit(user, action, entity, entityId, detail) {
  await db.prepare('INSERT INTO audit (id,at,user_id,user_name,role,action,entity,entity_id,detail) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(uid(), now(), user ? user.id : null, user ? user.name : null, user ? user.role : null,
         action, entity || null, entityId || null, detail || null);
}

async function addHistory(expenseId, byUser, action, detail) {
  await db.prepare('INSERT INTO expense_history (id,expense_id,by_user,action,detail,at) VALUES (?,?,?,?,?,?)')
    .run(uid(), expenseId, byUser, action, detail || null, now());
}

async function ready() {
  await initSchema();
  await seed();
}

module.exports = { db, uid, now, loadUser, scopeOf, nextVoucher, nextFundRequest, logAudit, addHistory, toPaise, toRupees, ready, pool };
