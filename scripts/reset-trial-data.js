'use strict';
/**
 * Wipes TRIAL/TRANSACTIONAL data only -- vouchers, evidence, queries, funds,
 * audit log, and history. Leaves your real setup untouched: user accounts,
 * projects, categories, and locations are NOT touched.
 *
 * Use this (not a full database wipe) once real projects/users exist that
 * you don't want to lose -- e.g. renamed projects, real site accounts.
 *
 * Deletes:
 *   - every row in: expenses, evidence, expense_history, funds,
 *     queries, query_messages, audit
 *   - every uploaded evidence file in uploads/ that belonged to a deleted voucher
 *   - resets the voucher number counter back to 1000 (next voucher: VCH-1001)
 *
 * Keeps completely untouched:
 *   - users, user_projects -- every account, password, role, project access
 *   - projects, categories, locations -- your Masters setup
 *
 * Uses the same DATABASE_URL as the app. IMPORTANT: stop the server first.
 *
 * Usage:
 *   npm run reset-data
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { db, pool } = require('../src/db');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const TRANSACTIONAL_TABLES = ['evidence', 'expense_history', 'query_messages', 'queries', 'funds', 'audit', 'expenses'];

async function counts() {
  const out = {};
  for (const t of [...TRANSACTIONAL_TABLES, 'users', 'projects', 'categories', 'locations']) {
    out[t] = (await db.prepare(`SELECT COUNT(*) c FROM ${t}`).get()).c;
  }
  return out;
}

(async () => {
  let before;
  try {
    before = await counts();
  } catch (e) {
    console.log('Could not read the database -- is it set up yet, and is DATABASE_URL correct?');
    console.log(e.message);
    await pool.end();
    process.exit(1);
  }

  if (before.expenses === 0 && before.audit === 0) {
    console.log('No trial data found -- nothing to reset.');
    await pool.end();
    process.exit(0);
  }

  const fileNames = (await db.prepare('SELECT filename FROM evidence').all()).map((r) => r.filename);

  console.log('\nThis will PERMANENTLY delete TRIAL DATA only:');
  console.log(`  - ${before.expenses} voucher(s)`);
  console.log(`  - ${before.queries} quer${before.queries === 1 ? 'y' : 'ies'} (+ ${before.query_messages} message(s))`);
  console.log(`  - ${before.funds} fund entr${before.funds === 1 ? 'y' : 'ies'}`);
  console.log(`  - ${before.evidence} evidence file(s)`);
  console.log(`  - ${before.expense_history} history record(s)`);
  console.log(`  - ${before.audit} audit log entr${before.audit === 1 ? 'y' : 'ies'}`);
  console.log('\nThis will be KEPT -- not touched:');
  console.log(`  - ${before.users} user account(s) (logins, passwords, roles, project access)`);
  console.log(`  - ${before.projects} project(s), ${before.categories} categor${before.categories === 1 ? 'y' : 'ies'}, ${before.locations} location(s)`);
  console.log('\nVoucher numbering resets -- next voucher will be VCH-1001.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question('Type YES to confirm: ', resolve));
  rl.close();

  if (answer.trim() !== 'YES') {
    console.log('Cancelled. Nothing was deleted.');
    await pool.end();
    return;
  }

  await db.transaction(async () => {
    for (const t of TRANSACTIONAL_TABLES) await db.prepare(`DELETE FROM ${t}`).run();
    await db.prepare("UPDATE counters SET seq=1000 WHERE name='voucher'").run();
  });

  let filesDeleted = 0;
  for (const fn of fileNames) {
    const p = path.join(UPLOADS_DIR, fn);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      filesDeleted++;
    }
  }

  console.log(`\nDone. Cleared ${before.expenses} voucher(s) and ${filesDeleted} evidence file(s).`);
  console.log('Users, projects, categories and locations are untouched.');
  console.log('Restart the server -- voucher numbering starts fresh at VCH-1001.\n');
  await pool.end();
})();
