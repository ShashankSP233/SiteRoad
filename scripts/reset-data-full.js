'use strict';
/**
 * FULL RESET -- deletes EVERYTHING, including user accounts, projects,
 * categories and locations, not just vouchers. Use this only if you want
 * to start completely over. For clearing out trial vouchers while keeping
 * your real users/projects, use `npm run reset-data` instead.
 *
 * Deletes every row in every table, and every file in uploads/.
 * On next `npm start`, the app re-seeds base projects/categories/locations
 * plus the default demo accounts (admin/site/checker/purchase/operations/
 * accounts) -- same as a brand new install.
 *
 * Uses the same DATABASE_URL as the app. IMPORTANT: stop the server first.
 *
 * Usage:
 *   npm run reset-data-full
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { db, pool } = require('../src/db');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
// child tables first, then parents, so foreign keys never block a DELETE
const ALL_TABLES = [
  'query_messages', 'queries', 'evidence', 'expense_history', 'expenses',
  'funds', 'project_budgets', 'user_projects', 'audit', 'schema_migrations',
  'users', 'projects', 'categories', 'locations', 'counters',
];

(async () => {
  let userCount;
  try {
    userCount = (await db.prepare('SELECT COUNT(*) c FROM users').get()).c;
  } catch (e) {
    console.log('Could not read the database -- is it set up yet, and is DATABASE_URL correct?');
    console.log(e.message);
    await pool.end();
    process.exit(1);
  }

  const uploadFiles = fs.existsSync(UPLOADS_DIR)
    ? fs.readdirSync(UPLOADS_DIR).filter((f) => f !== '.gitkeep')
    : [];

  console.log('\n⚠️  FULL RESET -- this also deletes your USERS and PROJECTS, not just vouchers.');
  console.log('If you only want to clear out trial vouchers and keep your real users/projects,');
  console.log('cancel this and run "npm run reset-data" instead.\n');
  console.log(`This will PERMANENTLY delete all ${userCount} user account(s), every project/`);
  console.log(`category/location, every voucher, and ${uploadFiles.length} file(s) in uploads/.\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question('Type YES to confirm: ', resolve));
  rl.close();

  if (answer.trim() !== 'YES') {
    console.log('Cancelled. Nothing was deleted.');
    await pool.end();
    return;
  }

  await db.transaction(async () => {
    for (const t of ALL_TABLES) await db.prepare(`DELETE FROM ${t}`).run();
  });

  let filesDeleted = 0;
  for (const fn of uploadFiles) {
    const p = path.join(UPLOADS_DIR, fn);
    if (fs.existsSync(p)) { fs.unlinkSync(p); filesDeleted++; }
  }

  console.log(`\nDone. Everything wiped (${filesDeleted} evidence file(s) removed).`);
  console.log('Run "npm start" -- it will reseed base projects/categories/locations');
  console.log('and the default accounts (admin/site/checker/purchase/operations/accounts).');
  console.log('Change every default password from the Users & Access screen before');
  console.log('putting the app in front of real users.\n');
  await pool.end();
})();
