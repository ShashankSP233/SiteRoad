'use strict';
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const {ZipArchive} = require('archiver');
const { db, uid, now, loadUser, scopeOf, nextVoucher, nextFundRequest, logAudit, addHistory, toPaise, toRupees } = require('./db');

const router = express.Router();
const USER_ROLES = new Set([
  'admin', 'site_accounts', 'general_manager', 'project_director',
  'senior_accountant', 'accounts_manager', 'account_checker',
]);
const UP_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UP_DIR)) fs.mkdirSync(UP_DIR, { recursive: true });

// ---------------------------------------------------------------- uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UP_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase().slice(0, 8);
    cb(null, uid() + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024, files: 12 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype) || file.mimetype === 'application/pdf'),
});

// ---------------------------------------------------------------- guards
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (!req.user.active) return res.status(403).json({ error: 'Account disabled' });
  next();
}
function requireRole(...roles) {
  return (req, res, next) =>
    roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Not permitted' });
}
router.use(requireAuth);

// ---------------------------------------------------------------- scope
// Pure functions -- no DB access, so these stay synchronous.
function scopeClause(user, alias = 'e') {
  const s = scopeOf(user);
  const clauses = [];
  const params = [];
  if (!s.all) {
    if (s.ids.length === 0) clauses.push('0=1');
    else {
      clauses.push(`${alias}.project_id IN (${s.ids.map(() => '?').join(',')})`);
      params.push(...s.ids);
    }
  }
  if (user.role === 'site_accounts') {
    clauses.push(`(${alias}.created_by = ? OR ${alias}.site_user_id = ?)`);
    params.push(user.id, user.id);
  }
  return { where: clauses.length ? ' AND ' + clauses.join(' AND ') : '', params };
}
function canSeeExpense(user, exp) {
  const s = scopeOf(user);
  if (!s.all && !s.ids.includes(exp.project_id)) return false;
  if (user.role === 'site_accounts' && exp.created_by !== user.id && exp.site_user_id !== user.id) return false;
  return true;
}
function inScope(user, projectId) {
  const s = scopeOf(user);
  return s.all || s.ids.includes(projectId);
}

// ---------------------------------------------------------------- lookups for display
async function nameMaps() {
  const [cats, projs, locs, users] = await Promise.all([
    db.prepare('SELECT id,name FROM categories').all(),
    db.prepare('SELECT id,code,name FROM projects').all(),
    db.prepare('SELECT id,name FROM locations').all(),
    db.prepare('SELECT id,name FROM users').all(),
  ]);
  return {
    cat: Object.fromEntries(cats.map(r => [r.id, r.name])),
    proj: Object.fromEntries(projs.map(r => [r.id, r])),
    loc: Object.fromEntries(locs.map(r => [r.id, r.name])),
    usr: Object.fromEntries(users.map(r => [r.id, r.name])),
  };
}
const DAY_MS = 86400000;

// P15/24/28/29 -- deadline for the voucher's current pending state (null if none)
async function computeSla(e) {
  if (e.status === 'Query') {
    // Query resolution remains a separate 7-day SLA from the latest open query.
    const q = await db
      .prepare("SELECT created_at FROM queries WHERE expense_id=? AND status='Open' ORDER BY created_at DESC LIMIT 1")
      .get(e.id);

    if (q) {
      return {
        kind: 'query',
        label: 'Query resolution',
        dueAt: q.created_at + 7 * DAY_MS
      };
    }

  } else if (e.status === 'Submitted') {
    // Checker review starts from the current submission/re-submission time.
    const anchor = e.submitted_at || e.created_at;

    const expDate = Date.parse((e.date || '') + 'T00:00:00');

    // A back-dated entry more than 7 days old is overdue immediately.
    const dueAt =
      (!isNaN(expDate) && (anchor - expDate) > 7 * DAY_MS)
        ? (expDate + 2 * DAY_MS)
        : (anchor + 2 * DAY_MS);

    return {
      kind: 'check',
      label: 'Checker review',
      dueAt
    };

  } else if (
    ['Checked', 'Purchase Reviewed', 'Operations Reviewed', 'Accounts Reviewed']
      .includes(e.status)
  ) {
    const ap = JSON.parse(e.approvals || '{}');

    // The current status tells us which step is ACTIVE.
    // The previous completed step's timestamp is therefore
    // the timestamp at which the current step was received.
    const anchors = {
      Checked: ap.check && ap.check.at,
      'Purchase Reviewed': ap.purchase && ap.purchase.at,
      'Operations Reviewed': ap.operations && ap.operations.at,
      'Accounts Reviewed': ap.accounts && ap.accounts.at
    };

    const anchor = anchors[e.status];

    if (anchor) {
      return {
        kind: 'review',
        label: 'Approval',
        dueAt: anchor + 2 * DAY_MS
      };
    }
  }

  return null;
}

function computeOverallSla(e) {
  if (!e.created_at) return null;

  const dueAt = e.created_at + 7 * DAY_MS;

  return {
    dueAt,
    overdue: Date.now() > dueAt,
  };
}


async function getPreviousDelays(e) {
  const rows = await db.prepare(`
    SELECT action, detail, at
    FROM expense_history
    WHERE expense_id=?
      AND detail LIKE 'Delayed — reason:%'
    ORDER BY at ASC
  `).all(e.id);

  return rows.map(h => ({
    stage: h.action || 'Review',
    reason: String(h.detail || '').replace(/^Delayed — reason:\s*/, ''),
    at: h.at
  }));
}

async function buildPaymentZip(res, expenses) {
  const archive = new ZipArchive({
    zlib: { level: 9 }
  });

  archive.on('error', err => {
    throw err;
  });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="siteexpense-payments-${Date.now()}.zip"`
  );

  archive.pipe(res);

  const cols = [
    'Voucher',
    'Date',
    'Details',
    'Category',
    'Project',
    'Location',
    'Bill',
    'Payment',
    'Amount',
    'Status',
    'Paid',
    'Paid On',
    'Created By',
  ];

  const csvEsc = v => {
    v = String(v ?? '');
    return /[",\n]/.test(v)
      ? '"' + v.replace(/"/g, '""') + '"'
      : v;
  };

  const dcell = ms => {
    const t = Number(ms);
    return (ms && !isNaN(t))
      ? new Date(t).toISOString().slice(0, 10)
      : '';
  };

  const lines = [cols.join(',')];

  for (const e of expenses) {
    const p = e.project;

    lines.push([
      e.voucher_no,
      e.date,
      e.details,
      e.categoryName,
      p ? p.code : '',
      e.locationName,
      e.bill_received || '',
      e.payment_status || '',
      toRupees(e.amount),
      e.status,
      e.paid ? 'Yes' : 'No',
      dcell(e.paid_at),
      e.createdByName,
    ].map(csvEsc).join(','));

    const evidence = await db
      .prepare('SELECT filename,original_name FROM evidence WHERE expense_id=? ORDER BY original_name ASC')
      .all(e.id);

    for (const f of evidence) {
      const filePath = path.join(UP_DIR, f.filename);

      if (!fs.existsSync(filePath)) {
        throw new Error(`Attachment file is missing for ${e.voucher_no}: ${f.original_name || f.filename}`);
      }

      const safeName = path.basename(f.original_name || f.filename);

      archive.file(filePath, {
        name: `${e.voucher_no}/attachments/${safeName}`,
      });
    }
  }

  archive.append('\ufeff' + lines.join('\n'), {
    name: 'payments.csv',
  });

  await archive.finalize();
}

async function decorate(e, m) {
  const p = m.proj[e.project_id];
  const [evCount, sla, previousDelays] = await Promise.all([
    db.prepare('SELECT COUNT(*) c FROM evidence WHERE expense_id=?').get(e.id),
    computeSla(e),
    getPreviousDelays(e),
  ]);
  const overallSla = computeOverallSla(e);
  return {
    ...e,
    amount: toRupees(e.amount),
    approvals: JSON.parse(e.approvals || '{}'),
    categoryName: m.cat[e.category_id] || '—',
    projectCode: p ? p.code : '—',
    projectName: p ? `${p.code} · ${p.name}` : '—',
    locationName: m.loc[e.location_id] || '—',
    createdByName: m.usr[e.created_by] || '—',
    siteUserName: m.usr[e.site_user_id || e.created_by] || '—',
    evidenceCount: evCount.c,
    sla,
    overallSla,
    previousDelays,
  };
}

// ---------------------------------------------------------------- submit-time rules
// P14 -- entries may not be dated more than 7 days before today (site only; admin exempt)
function entryDateError(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return 'Invalid date';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((today.getTime() - d.getTime()) / 86400000);
  if (diffDays > 7) return `Entries older than 7 days are not allowed (this one is ${diffDays} days old). Please ask an admin for any back-dated entry.`;
  return null;
}
// P13 -- duplicate if (project+date+amount+category) match, or the bill number matches.
// amount must be passed in already converted to paise (see toPaise).
const normBill = s => String(s == null ? '' : s).toLowerCase().replace(/[\s\-/]/g, '').replace(/^0+(?=\d)/, '');
async function findDuplicate({ projectId, date, amount, categoryId, billNo, excludeId }) {
  const ex = excludeId || '';
  const a = await db.prepare(
    `SELECT voucher_no FROM expenses
       WHERE status!='Rejected' AND id!=? AND project_id=? AND date=? AND amount=?
         AND COALESCE(category_id,'')=COALESCE(?,'') LIMIT 1`
  ).get(ex, projectId, date, amount, categoryId || null);
  if (a) return { match: a.voucher_no, message: `Possible duplicate of ${a.voucher_no} — same project, date, amount and category. Submit anyway?` };
  const bn = (billNo == null ? '' : String(billNo)).trim();
  if (bn) {
    const b2 = await db.prepare(
      `SELECT voucher_no FROM expenses WHERE status!='Rejected' AND id!=? AND COALESCE(bill_no,'')=? LIMIT 1`
    ).get(ex, bn);
    if (b2) return { match: b2.voucher_no, message: `Possible duplicate — bill no. "${bn}" is already on ${b2.voucher_no}. Submit anyway?` };
    // near-match: same bill number once spacing/dashes/leading zeros are ignored
    const nb = normBill(bn);
    if (nb) {
      const candidates = await db.prepare(
        `SELECT voucher_no, bill_no FROM expenses WHERE status!='Rejected' AND id!=? AND bill_no IS NOT NULL AND bill_no!=''`
      ).all(ex);
      const near = candidates.find(c => normBill(c.bill_no) === nb);
      if (near) return { match: near.voucher_no, probable: true, message: `Bill no. "${bn}" looks like "${near.bill_no}" already on ${near.voucher_no} (differs only in spacing/formatting). Submit anyway?` };
    }
  }
  return null;
}
// P2 -- resolve a typed/selected location name to an id, creating it on the fly if new
async function resolveLocationId(name) {
  const nm = (name || '').trim();
  if (!nm) return null;
  const existing = await db.prepare('SELECT id FROM locations WHERE lower(name)=lower(?) LIMIT 1').get(nm);
  if (existing) return existing.id;
  const id = uid();
  await db.prepare('INSERT INTO locations (id,name,active) VALUES (?,?,1)').run(id, nm);
  return id;
}

// ================================================================ BOOTSTRAP
router.get('/bootstrap', async (req, res) => {
  const u = req.user;
  const [activeProjects, allProjects, categories, locations, users] = await Promise.all([
    db.prepare('SELECT * FROM projects WHERE active=1').all(),
    db.prepare('SELECT * FROM projects').all(),
    db.prepare('SELECT * FROM categories WHERE active=1').all(),
    db.prepare('SELECT * FROM locations WHERE active=1').all(),
    db.prepare('SELECT id,name,role,active FROM users').all(),
  ]);
  res.json({
    user: {
      id: u.id, name: u.name, username: u.username, role: u.role,
      allProjects: u.all_projects, projectIds: u.project_ids,
    },
    projects: activeProjects.filter(p => inScope(u, p.id)),
    allProjects,       // admin views
    categories,
    locations,
    users,
  });
});

// ================================================================ EXPENSES
router.get('/expenses', async (req, res) => {
  const m = await nameMaps();
  const sc = scopeClause(req.user, 'e');
  const filters = [];
  const params = [...sc.params];
  if (req.query.status) { filters.push('e.status = ?'); params.push(req.query.status); }
  if (req.query.projectId) { filters.push('e.project_id = ?'); params.push(req.query.projectId); }
  if (req.query.categoryId) { filters.push('e.category_id = ?'); params.push(req.query.categoryId); }
  const extra = filters.length ? ' AND ' + filters.join(' AND ') : '';
  const rows = await db.prepare(
    `SELECT e.* FROM expenses e WHERE 1=1 ${sc.where} ${extra} ORDER BY e.created_at DESC`
  ).all(...params);
  res.json(await Promise.all(rows.map(r => decorate(r, m))));
});

router.get('/expenses/:id', async (req, res) => {
  const e = await db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  if (!canSeeExpense(req.user, e)) return res.status(403).json({ error: 'Not permitted' });
  const m = await nameMaps();
  const [evidence, historyRows, queryRows] = await Promise.all([
    db.prepare('SELECT id,original_name,mime FROM evidence WHERE expense_id=?').all(e.id),
    db.prepare('SELECT * FROM expense_history WHERE expense_id=? ORDER BY at ASC').all(e.id),
    db.prepare('SELECT * FROM queries WHERE expense_id=? ORDER BY created_at DESC').all(e.id),
  ]);
  const history = historyRows.map(h => ({ ...h, byName: m.usr[h.by_user] || '—' }));
  const queries = await Promise.all(queryRows.map(async q => ({
    ...q,
    raisedByName: m.usr[q.raised_by], assignedToName: m.usr[q.assigned_to],
    thread: (await db.prepare('SELECT * FROM query_messages WHERE query_id=? ORDER BY at ASC').all(q.id))
      .map(t => ({ ...t, byName: m.usr[t.by_user] || '—' })),
  })));
  res.json({ ...(await decorate(e, m)), evidence, history, queries });
});

router.post('/expenses', upload.array('photos', 12), requireRole('site_accounts', 'general_manager', 'admin'), async (req, res) => {
  const b = req.body;
  if (!b.date || !b.amount || !b.details) return res.status(400).json({ error: 'Date, amount and details required' });
  if (!inScope(req.user, b.projectId)) return res.status(403).json({ error: 'Project not in your access' });
  const siteUserId = req.user.role === 'site_accounts' ? req.user.id : String(b.siteUserId || '').trim();
  if (!siteUserId) return res.status(400).json({ error: 'Select the Site Accounts user responsible for this expense' });
  const siteUser = await loadUser(siteUserId);
  if (!siteUser || siteUser.role !== 'site_accounts' || !siteUser.active) return res.status(400).json({ error: 'Expense owner must be an active Site Accounts user' });
  if (!siteUser.all_projects && !(siteUser.project_ids || []).includes(b.projectId)) return res.status(400).json({ error: 'The selected Site Accounts user is not assigned to this project' });
  const asDraft = b.asDraft === 'true' || b.asDraft === true;

  // P14 -- site/checker cannot enter expenses dated more than 7 days ago
  if (['site_accounts', 'general_manager'].includes(req.user.role)) {
    const dErr = entryDateError(b.date);
    if (dErr) return res.status(400).json({ error: dErr });
  }
  // P10 -- a photo/image is required to submit (a draft may be saved without one)
  if (!asDraft && (!req.files || req.files.length === 0)) {
    return res.status(400).json({ error: 'Please attach at least one photo/image of the bill or payment before submitting. (You can Save Draft without one.)' });
  }
  // P13 -- on submit, alert on a likely duplicate unless the user has confirmed
  const confirmDup = b.confirmDuplicate === 'true' || b.confirmDuplicate === true;
  if (!asDraft && !confirmDup) {
    const dup = await findDuplicate({ projectId: b.projectId, date: b.date, amount: toPaise(b.amount), categoryId: b.categoryId, billNo: b.billNo });
    if (dup) return res.status(409).json({ error: dup.message, duplicate: true, match: dup.match });
  }

  const id = uid();
  const locationId = b.location != null ? await resolveLocationId(b.location) : (b.locationId || null);
  // A General Manager enters expenses directly and is their own checker, so the voucher starts
  // already "Checked" (workflow begins at Purchase). Everyone else starts at "Submitted".
  const checkerEntry = req.user.role === 'general_manager';
  const status = asDraft ? 'Draft' : (checkerEntry ? 'Checked' : 'Submitted');
  const approvals = (!asDraft && checkerEntry) ? JSON.stringify({ check: { by: req.user.id, at: now() } }) : '{}';
  // voucher + evidence + history + audit succeed or roll back together
  let voucher;

  await db.transaction(async () => {
    voucher = await nextVoucher();

    await db.prepare(`INSERT INTO expenses
      (id,voucher_no,date,amount,category_id,details,project_id,location_id,site_user_id,expense_done_by,
      bill_received,bill_no,payment_status,remark,status,approvals,created_by,created_at,updated_at,submitted_at,paid)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, voucher, b.date, toPaise(b.amount), b.categoryId || null, b.details, b.projectId,
      locationId, siteUserId, b.expenseDoneBy || req.user.name, b.billReceived || 'No',
      b.billNo || null, 'Pending', b.remark || null, status, approvals,
      req.user.id, now(), now(), asDraft ? null : now(),
      b.paid === '1' ? 1 : 0
    );

    for (const f of (req.files || [])) {
      await db.prepare('INSERT INTO evidence (id,expense_id,filename,original_name,mime) VALUES (?,?,?,?,?)')
        .run(uid(), id, f.filename, f.originalname, f.mimetype);
    }

    await addHistory(id, req.user.id, asDraft ? 'Created draft' : 'Submitted', 'Voucher created');
    await logAudit(req.user, asDraft ? 'Created draft' : 'Submitted expense', 'expense', voucher, '₹' + b.amount);
  });
    res.json({ id, voucherNo: voucher });
  });

// creator edits their own while still editable (or admin)
router.patch('/expenses/:id', async (req, res) => {
  const e = await db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  const isOwnerEditable = req.user.role === 'site_accounts' && (e.created_by === req.user.id || e.site_user_id === req.user.id) &&
    ['Draft', 'Submitted', 'Query'].includes(e.status);
  if (!(isOwnerEditable || req.user.role === 'admin')) return res.status(403).json({ error: 'Not editable' });
  const b = req.body;
  const willSubmit = !b.asDraft;
  // P14 -- keep the 7-day rule on edits too (site only)
  if (req.user.role === 'site_accounts' && b.date) {
    const dErr = entryDateError(b.date);
    if (dErr) return res.status(400).json({ error: dErr });
  }
  // P10 -- cannot move a voucher to Submitted without at least one evidence image
  if (willSubmit) {
    const evCount = await db.prepare('SELECT COUNT(*) c FROM evidence WHERE expense_id=?').get(e.id);
    if (evCount.c === 0) return res.status(400).json({ error: 'This voucher has no photo/image attached, so it cannot be submitted. Please attach evidence first.' });
  }
  const locationId = b.location != null ? await resolveLocationId(b.location) : (b.locationId ?? e.location_id);
  await db.prepare(`UPDATE expenses SET date=?,amount=?,category_id=?,details=?,location_id=?,
    expense_done_by=?,bill_received=?,bill_no=?,remark=?,status=?,submitted_at=?,updated_at=? WHERE id=?`).run(
    b.date ?? e.date, b.amount != null ? toPaise(b.amount) : e.amount, b.categoryId ?? e.category_id,
    b.details ?? e.details, locationId, b.expenseDoneBy ?? e.expense_done_by,
    b.billReceived ?? e.bill_received, b.billNo ?? e.bill_no,
    b.remark ?? e.remark, (b.asDraft ? 'Draft' : 'Submitted'), (willSubmit ? now() : e.submitted_at), now(), e.id);
  await addHistory(e.id, req.user.id, 'Edited', 'Updated voucher');
  await logAudit(req.user, 'Edited expense', 'expense', e.voucher_no, '');
  res.json({ ok: true });
});

// ---- sequential review ladder (server-enforced order) ----
const FLOW = {
  check:      { from: 'Submitted',           to: 'Checked',             role: 'general_manager',    key: 'check',      label: 'Checked by General Manager' },
  purchase:   { from: 'Checked',             to: 'Purchase Reviewed',   role: 'project_director',   key: 'purchase',   label: 'Reviewed by Project Director / Incharge' },
  operations: { from: 'Purchase Reviewed',   to: 'Operations Reviewed', role: 'senior_accountant', key: 'operations', label: 'Reviewed by Senior Accountant' },
  accounts:   { from: 'Operations Reviewed', to: 'Accounts Reviewed',   roles: ['accounts_manager', 'account_checker'], key: 'accounts', label: 'Reviewed by Accounts Manager / Head' },
  approve:    { from: 'Accounts Reviewed',   to: 'Approved',            role: 'accounts_manager',   key: 'approved',   label: 'Approved' },
};
router.post('/expenses/:id/advance/:step', async (req, res) => {
  const step = FLOW[req.params.step];
  if (!step) return res.status(400).json({ error: 'Unknown step' });
  const e = await db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  const stepAllowed = step.roles
    ? step.roles.includes(req.user.role)
    : req.user.role === step.role;
  if (!stepAllowed && req.user.role !== 'admin')
    return res.status(403).json({ error: `Only ${step.roles ? step.roles.join(' or ') : step.role} can do this step` });
  if (!inScope(req.user, e.project_id)) return res.status(403).json({ error: 'Project not in your access' });
  if (e.status !== step.from)
    return res.status(409).json({ error: `Voucher must be "${step.from}" first (it is "${e.status}")` });
  // Delay justification -- an overdue step cannot proceed without a reason for the delay
  const sla = await computeSla(e);
  const overdue = sla && Date.now() > sla.dueAt;
  const reason = ((req.body && req.body.reason) || '').trim();
  if (overdue && !reason) return res.status(409).json({ error: 'This action is overdue — please provide a reason for the delay to proceed.', needReason: true });
  const approvals = JSON.parse(e.approvals || '{}');
  approvals[step.key] = { by: req.user.id, at: now() };
  // Atomic: re-check status in the same statement that changes it, so two
  // simultaneous requests can't both succeed against the same "from" state.
  const result = await db.prepare('UPDATE expenses SET status=?,approvals=?,updated_at=? WHERE id=? AND status=?')
    .run(step.to, JSON.stringify(approvals), now(), e.id, step.from);
  if (result.changes === 0) {
    return res.status(409).json({ error: 'This voucher was just updated by someone else — please refresh and try again.' });
  }
  await addHistory(e.id, req.user.id, step.label, overdue ? ('Delayed — reason: ' + reason) : '');
  await logAudit(req.user, step.label, 'expense', e.voucher_no, overdue ? ('delay: ' + reason) : '');
  res.json({ ok: true, status: step.to });
});

router.post('/expenses/:id/reject', requireRole('general_manager', 'project_director', 'senior_accountant', 'accounts_manager', 'account_checker', 'admin'), async (req, res) => {
  const e = await db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  if (!inScope(req.user, e.project_id)) return res.status(403).json({ error: 'Project not in your access' });
  if (!['Submitted', 'Checked', 'Purchase Reviewed', 'Operations Reviewed', 'Accounts Reviewed'].includes(e.status))
    return res.status(409).json({ error: 'Cannot reject at this stage' });
  const reason = (req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Reason required' });
  await db.prepare('UPDATE expenses SET status=?,updated_at=? WHERE id=?').run('Rejected', now(), e.id);
  await addHistory(e.id, req.user.id, 'Rejected', reason);
  await logAudit(req.user, 'Rejected expense', 'expense', e.voucher_no, reason);
  res.json({ ok: true });
});

router.post('/expenses/:id/query', requireRole('general_manager', 'project_director', 'senior_accountant', 'accounts_manager', 'account_checker', 'admin'), async (req, res) => {
  const e = await db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  if (!inScope(req.user, e.project_id)) return res.status(403).json({ error: 'Project not in your access' });
  if (!['Submitted', 'Checked', 'Purchase Reviewed', 'Operations Reviewed', 'Accounts Reviewed'].includes(e.status))
    return res.status(409).json({ error: `Cannot raise a query while voucher is "${e.status}"` });
  const to = e.site_user_id || e.created_by; // query the Site Accounts owner when a manager entered the voucher
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Query text required' });
  const qid = uid();
  await db.prepare(`INSERT INTO queries (id,expense_id,voucher_no,raised_by,assigned_to,text,status,prev_status,created_at)
    VALUES (?,?,?,?,?,?,'Open',?,?)`).run(qid, e.id, e.voucher_no, req.user.id, to, text, e.status, now());
  await db.prepare('INSERT INTO query_messages (id,query_id,by_user,text,at) VALUES (?,?,?,?,?)')
    .run(uid(), qid, req.user.id, text, now());
  await db.prepare('UPDATE expenses SET status=?,prev_status=?,updated_at=? WHERE id=?')
    .run('Query', e.status, now(), e.id);
  await addHistory(e.id, req.user.id, 'Query raised', text);
  await logAudit(req.user, 'Raised query', 'expense', e.voucher_no, '');
  res.json({ ok: true, queryId: qid });
});

// evidence image (access-checked, not statically exposed)
router.get('/evidence/:id', async (req, res) => {
  const ev = await db.prepare('SELECT * FROM evidence WHERE id=?').get(req.params.id);
  if (!ev) return res.sendStatus(404);
  const e = await db.prepare('SELECT * FROM expenses WHERE id=?').get(ev.expense_id);
  if (!e || !canSeeExpense(req.user, e)) return res.sendStatus(403);
  res.sendFile(path.join(UP_DIR, ev.filename));
});

// ================================================================ QUERIES
router.post('/queries/:id/reply', async (req, res) => {
  const q = await db.prepare('SELECT * FROM queries WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const eR = await db.prepare('SELECT * FROM expenses WHERE id=?').get(q.expense_id);
  const allowed = [q.assigned_to, q.raised_by].includes(req.user.id) || req.user.role === 'admin' || (eR && (eR.created_by === req.user.id || eR.site_user_id === req.user.id));
  if (!allowed) return res.status(403).json({ error: 'Not permitted' });
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Empty reply' });
  await db.prepare('INSERT INTO query_messages (id,query_id,by_user,text,at) VALUES (?,?,?,?,?)')
    .run(uid(), q.id, req.user.id, text, now());
  res.json({ ok: true });
});
router.post('/queries/:id/resolve', async (req, res) => {
  const q = await db.prepare('SELECT * FROM queries WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const e = await db.prepare('SELECT * FROM expenses WHERE id=?').get(q.expense_id);
  const allowed = q.assigned_to === req.user.id || req.user.role === 'admin' || (e && (e.created_by === req.user.id || e.site_user_id === req.user.id));
  if (!allowed) return res.status(403).json({ error: 'Only the voucher owner or assignee can resolve' });
  // Delay justification -- an overdue query cannot be resolved without a reason for the delay
  const qsla = await computeSla(e);
  const overdue = e.status === 'Query' && qsla && Date.now() > qsla.dueAt;
  const reason = ((req.body && req.body.reason) || '').trim();
  if (overdue && !reason) return res.status(409).json({ error: 'Query resolution is overdue — please provide a reason for the delay to proceed.', needReason: true });
  await db.prepare("UPDATE queries SET status='Resolved',resolved_at=? WHERE id=?").run(now(), q.id);
  await db.prepare('INSERT INTO query_messages (id,query_id,by_user,text,at) VALUES (?,?,?,?,?)')
    .run(uid(), q.id, req.user.id, overdue ? ('Marked resolved. Delay reason: ' + reason) : 'Marked resolved.', now());
  const stillOpen = await db.prepare("SELECT 1 FROM queries WHERE expense_id=? AND status='Open' LIMIT 1").get(q.expense_id);
  if (!stillOpen && e && e.status === 'Query') {
    // P12/23 -- full ladder reset: once all queries are resolved, the voucher returns to
    // the start and the whole chain re-approves (checker -> purchase -> operations ->
    // accounts), regardless of who raised the query or at which stage. History is retained.
    const creator = await loadUser(e.created_by);
    const checkerVoucher = creator && creator.role === 'general_manager';
    const resetStatus = checkerVoucher ? 'Checked' : 'Submitted';
    const resetApprovals = checkerVoucher ? JSON.stringify({ check: { by: e.created_by, at: now() } }) : '{}';
    await db.prepare("UPDATE expenses SET status=?,approvals=?,prev_status=NULL,submitted_at=?,updated_at=? WHERE id=?")
      .run(resetStatus, resetApprovals, now(), now(), e.id);
    await addHistory(e.id, req.user.id, 'Query resolved', checkerVoucher ? 'Re-opened — re-approval from Project Director / Incharge onward' : 'Re-submitted — full re-approval required (General Manager → Project Director / Incharge → Senior Accountant → Accounts Manager / Head)');
  }
  await logAudit(req.user, 'Resolved query', 'expense', q.voucher_no, '');
  res.json({ ok: true });
});

// P9/21 -- attach extra photos/PDFs to a voucher while answering a query
router.post('/queries/:id/attach', upload.array('files', 12), async (req, res) => {
  const q = await db.prepare('SELECT * FROM queries WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const e = await db.prepare('SELECT * FROM expenses WHERE id=?').get(q.expense_id);
  const allowed = [q.assigned_to, q.raised_by].includes(req.user.id) || req.user.role === 'admin' || (e && (e.created_by === req.user.id || e.site_user_id === req.user.id));
  if (!allowed) return res.status(403).json({ error: 'Not permitted' });
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No files attached' });
  for (const f of files) {
    await db.prepare('INSERT INTO evidence (id,expense_id,filename,original_name,mime) VALUES (?,?,?,?,?)')
      .run(uid(), q.expense_id, f.filename, f.originalname, f.mimetype);
  }
  const names = files.map(f => f.originalname).join(', ');
  await db.prepare('INSERT INTO query_messages (id,query_id,by_user,text,at) VALUES (?,?,?,?,?)')
    .run(uid(), q.id, req.user.id, 'Attached: ' + names, now());
  await addHistory(q.expense_id, req.user.id, 'Attached evidence', names);
  await logAudit(req.user, 'Attached evidence', 'expense', q.voucher_no, names);
  res.json({ ok: true, added: files.length });
});

// ================================================================ FUNDS & BALANCE
router.get('/funds', async (req, res) => {
  const visibleRoles = ['site_accounts', 'general_manager', 'senior_accountant', 'accounts_manager', 'admin'];
  if (!visibleRoles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Not permitted' });
  }
  const m = await nameMaps();
  const s = scopeOf(req.user);
  const role = req.user.role;
  let projFilter = s.all ? (await db.prepare('SELECT id FROM projects WHERE active=1').all()).map(r => r.id) : s.ids;
  const inq = projFilter.length ? projFilter.map(() => '?').join(',') : "''";
  const spendRows = await db.prepare(`
    SELECT COALESCE(site_user_id,created_by) site_user_id, COALESCE(SUM(amount),0) spent
    FROM expenses
    WHERE status NOT IN ('Rejected','Draft') AND project_id IN (${inq})
    GROUP BY COALESCE(site_user_id,created_by)
  `).all(...projFilter);
  const spentByUser = Object.fromEntries(spendRows.map(r => [r.site_user_id, toRupees(r.spent)]));

  if (role === 'site_accounts') {
    const [receivedRow, movementRows] = await Promise.all([
      db.prepare("SELECT COALESCE(SUM(amount),0) amount FROM funds WHERE kind='allocation' AND to_user=?").get(req.user.id),
      db.prepare("SELECT * FROM funds WHERE kind='allocation' AND to_user=? ORDER BY created_at DESC").all(req.user.id),
    ]);
    const received = toRupees(receivedRow.amount);
    const spent = spentByUser[req.user.id] || 0;
    return res.json({ role, totals: { received, spent, balance: received - spent }, siteBalances: [], funds: movementRows.map(f => ({ ...f, amount: toRupees(f.amount), projectCode: (m.proj[f.project_id] || {}).code, addedByName: m.usr[f.added_by], toUserName: req.user.name })) });
  }

  const users = await db.prepare("SELECT id,name FROM users WHERE role='site_accounts' AND active=1 ORDER BY name").all();
  const allocations = await db.prepare(`
    SELECT f.to_user, COALESCE(SUM(f.amount),0) amount
    FROM funds f JOIN projects p ON p.id=f.project_id
    WHERE f.kind='allocation' AND f.to_user IS NOT NULL AND f.project_id IN (${inq})
    GROUP BY f.to_user
  `).all(...projFilter);
  const allocatedByUser = Object.fromEntries(allocations.map(r => [r.to_user, toRupees(r.amount)]));
  const siteBalances = users.map(u => {
    const received = allocatedByUser[u.id] || 0;
    const spent = spentByUser[u.id] || 0;
    return { userId: u.id, userName: u.name, received, spent, balance: received - spent };
  });
  const funds = await db.prepare(`SELECT * FROM funds WHERE kind='allocation' AND to_user IS NOT NULL AND project_id IN (${inq}) ORDER BY created_at DESC`).all(...projFilter);
  res.json({ role, totals: siteBalances.reduce((t, b) => ({ received: t.received + b.received, spent: t.spent + b.spent, balance: t.balance + b.balance }), { received: 0, spent: 0, balance: 0 }), siteBalances, funds: funds.map(f => ({ ...f, amount: toRupees(f.amount), projectCode: (m.proj[f.project_id] || {}).code, addedByName: m.usr[f.added_by], toUserName: m.usr[f.to_user] || null })) });
});

// ================================================================ USERS & ACCESS (admin)
router.get('/users', requireRole('admin'), async (req, res) => {
  const users = await db.prepare('SELECT id,username,name,role,all_projects,active,created_at FROM users').all();
  for (const u of users) {
    u.all_projects = !!u.all_projects; u.active = !!u.active;
    u.project_ids = (await db.prepare('SELECT project_id FROM user_projects WHERE user_id=?').all(u.id)).map(r => r.project_id);
  }
  res.json(users);
});
router.post('/users', requireRole('admin'), async (req, res) => {
  const { username, name, role, password, allProjects, projectIds } = req.body;
  if (!username || !name || !role || !password) return res.status(400).json({ error: 'Missing fields' });
  if (!USER_ROLES.has(role)) return res.status(400).json({ error: 'Select a valid SiteRoad role' });
  if (await db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) return res.status(409).json({ error: 'Username exists' });
  const id = uid();
  await db.prepare('INSERT INTO users (id,username,name,password_hash,role,all_projects,active,created_at) VALUES (?,?,?,?,?,?,1,?)')
    .run(id, username, name, bcrypt.hashSync(password, 10), role, allProjects ? 1 : 0, now());
  if (!allProjects) {
    for (const pid of (projectIds || [])) {
      await db.prepare('INSERT INTO user_projects (user_id,project_id) VALUES (?,?) ON CONFLICT (user_id,project_id) DO NOTHING').run(id, pid);
    }
  }
  await logAudit(req.user, 'Created user', 'user', username, role);
  res.json({ id });
});
router.patch('/users/:id', requireRole('admin'), async (req, res) => {
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const { username, name, role, password, allProjects, projectIds } = req.body;
  if (role && !USER_ROLES.has(role)) return res.status(400).json({ error: 'Select a valid SiteRoad role' });
  const newUsername = (username || '').trim();
  if (newUsername && newUsername !== u.username) {
    const clash = await db.prepare('SELECT 1 FROM users WHERE username=? AND id!=?').get(newUsername, u.id);
    if (clash) return res.status(409).json({ error: 'Username already exists' });
  }
  await db.prepare('UPDATE users SET username=?,name=?,role=?,all_projects=? WHERE id=?')
    .run(newUsername || u.username, name ?? u.name, role ?? u.role, allProjects ? 1 : 0, u.id);
  if (password) await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password, 10), u.id);
  await db.prepare('DELETE FROM user_projects WHERE user_id=?').run(u.id);
  if (!allProjects) {
    for (const pid of (projectIds || [])) {
      await db.prepare('INSERT INTO user_projects (user_id,project_id) VALUES (?,?) ON CONFLICT (user_id,project_id) DO NOTHING').run(u.id, pid);
    }
  }
  await logAudit(req.user, 'Edited user', 'user', newUsername || u.username, role || u.role);
  res.json({ ok: true });
});
router.post('/users/:id/toggle', requireRole('admin'), async (req, res) => {
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'Cannot disable yourself' });
  await db.prepare('UPDATE users SET active=? WHERE id=?').run(u.active ? 0 : 1, u.id);
  res.json({ ok: true });
});

// ================================================================ ACCOUNT CHECKERS (accounts manager)
function requireAccountCheckerTarget(req, res, next) {
  if (req.user.role !== 'accounts_manager') return res.status(403).json({ error: 'Not permitted' });
  return next();
}

router.get('/account-checkers', requireAccountCheckerTarget, async (req, res) => {
  const users = await db.prepare(
    "SELECT id,username,name,role,all_projects,active,created_at FROM users WHERE role='account_checker' ORDER BY name"
  ).all();
  for (const u of users) {
    u.all_projects = !!u.all_projects;
    u.active = !!u.active;
    u.project_ids = (await db.prepare('SELECT project_id FROM user_projects WHERE user_id=?').all(u.id)).map(r => r.project_id);
  }
  res.json(users);
});

router.post('/account-checkers', requireAccountCheckerTarget, async (req, res) => {
  const { username, name, password, allProjects, projectIds } = req.body;
  if (!username || !name || !password) return res.status(400).json({ error: 'Missing fields' });
  if (await db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) return res.status(409).json({ error: 'Username exists' });
  const id = uid();
  await db.prepare('INSERT INTO users (id,username,name,password_hash,role,all_projects,active,created_at) VALUES (?,?,?,?,?,?,1,?)')
    .run(id, username, name, bcrypt.hashSync(password, 10), 'account_checker', allProjects ? 1 : 0, now());
  if (!allProjects) {
    for (const pid of (projectIds || [])) {
      await db.prepare('INSERT INTO user_projects (user_id,project_id) VALUES (?,?) ON CONFLICT (user_id,project_id) DO NOTHING').run(id, pid);
    }
  }
  await logAudit(req.user, 'Created account checker', 'user', username, 'account_checker');
  res.json({ id });
});

router.patch('/account-checkers/:id', requireAccountCheckerTarget, async (req, res) => {
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u || u.role !== 'account_checker') return res.status(404).json({ error: 'Account Checker not found' });
  const { username, name, password, allProjects, projectIds } = req.body;
  const newUsername = (username || '').trim();
  if (newUsername && newUsername !== u.username) {
    const clash = await db.prepare('SELECT 1 FROM users WHERE username=? AND id!=?').get(newUsername, u.id);
    if (clash) return res.status(409).json({ error: 'Username already exists' });
  }
  await db.prepare('UPDATE users SET username=?,name=?,all_projects=?,role=? WHERE id=?')
    .run(newUsername || u.username, name ?? u.name, allProjects ? 1 : 0, 'account_checker', u.id);
  if (password) await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password, 10), u.id);
  await db.prepare('DELETE FROM user_projects WHERE user_id=?').run(u.id);
  if (!allProjects) {
    for (const pid of (projectIds || [])) {
      await db.prepare('INSERT INTO user_projects (user_id,project_id) VALUES (?,?) ON CONFLICT (user_id,project_id) DO NOTHING').run(u.id, pid);
    }
  }
  await logAudit(req.user, 'Edited account checker', 'user', newUsername || u.username, 'account_checker');
  res.json({ ok: true });
});

router.post('/account-checkers/:id/toggle', requireAccountCheckerTarget, async (req, res) => {
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u || u.role !== 'account_checker') return res.status(404).json({ error: 'Account Checker not found' });
  await db.prepare('UPDATE users SET active=? WHERE id=?').run(u.active ? 0 : 1, u.id);
  res.json({ ok: true });
});

router.post('/me/password', requireRole('admin', 'accounts_manager', 'account_checker'), async (req, res) => {
  const password = String(req.body.password || '');
  if (!password) return res.status(400).json({ error: 'Password is required' });
  await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password, 10), req.user.id);
  res.json({ ok: true });
});

// ================================================================ MASTERS (admin)
const MASTER_TABLES = { categories: 1, projects: 1, locations: 1 };
router.get('/masters', requireRole('admin'), async (req, res) => {
  const [categories, projects, locations] = await Promise.all([
    db.prepare('SELECT * FROM categories ORDER BY name').all(),
    db.prepare('SELECT * FROM projects ORDER BY code').all(),
    db.prepare('SELECT * FROM locations ORDER BY name').all(),
  ]);
  res.json({ categories, projects, locations });
});
router.post('/masters/:type', requireRole('admin'), async (req, res) => {
  const t = req.params.type;
  if (!MASTER_TABLES[t]) return res.status(400).json({ error: 'Bad master type' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (t === 'projects') {
    const code = (req.body.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Code required' });
    await db.prepare('INSERT INTO projects (id,code,name,active) VALUES (?,?,?,1)').run(uid(), code, name);
  } else {
    await db.prepare(`INSERT INTO ${t} (id,name,active) VALUES (?,?,1)`).run(uid(), name);
  }
  await logAudit(req.user, 'Added master', 'master', t, name);
  res.json({ ok: true });
});
router.post('/masters/:type/:id/toggle', requireRole('admin'), async (req, res) => {
  const t = req.params.type;
  if (!MASTER_TABLES[t]) return res.status(400).json({ error: 'Bad master type' });
  const row = await db.prepare(`SELECT * FROM ${t} WHERE id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  await db.prepare(`UPDATE ${t} SET active=? WHERE id=?`).run(row.active ? 0 : 1, row.id);
  res.json({ ok: true });
});
router.post('/masters/:type/:id/rename', requireRole('admin'), async (req, res) => {
  const t = req.params.type;
  if (!MASTER_TABLES[t]) return res.status(400).json({ error: 'Bad master type' });
  const row = await db.prepare(`SELECT * FROM ${t} WHERE id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  await db.prepare(`UPDATE ${t} SET name=? WHERE id=?`).run(name, row.id);
  if (t === 'projects') {
    const code = (req.body.code || '').trim();
    if (code) await db.prepare('UPDATE projects SET code=? WHERE id=?').run(code, row.id);
  }
  await logAudit(req.user, 'Renamed master', 'master', t, `${row.name} → ${name}`);
  res.json({ ok: true });
});

// ================================================================ REPORTS (CSV)
router.get('/reports/expenses.csv', requireRole('accounts_manager', 'admin'), async (req, res) => {
  const m = await nameMaps();
  const sc = scopeClause(req.user, 'e');
  const params = [...sc.params];
  const f = [];
  if (req.query.from) { f.push('e.date >= ?'); params.push(req.query.from); }
  if (req.query.to) { f.push('e.date <= ?'); params.push(req.query.to); }
  if (req.query.status === '__paid') { f.push('COALESCE(e.paid,0) = 1'); }
  else if (req.query.status === '__unpaid') { f.push("e.status='Approved' AND COALESCE(e.paid,0) = 0"); }
  else if (req.query.status) { f.push('e.status = ?'); params.push(req.query.status); }
  if (req.query.projectId) { f.push('e.project_id = ?'); params.push(req.query.projectId); }
  const extra = f.length ? ' AND ' + f.join(' AND ') : '';
  const rows = await db.prepare(`SELECT e.* FROM expenses e WHERE 1=1 ${sc.where} ${extra} ORDER BY e.date ASC`).all(...params);
  const cols = ['Voucher', 'Date', 'Details', 'Category', 'Project', 'Location', 'Bill', 'Payment', 'Amount', 'Status', 'Paid', 'Paid On', 'Created By'];
  const esc = v => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const dcell = ms => { const t = Number(ms); return (ms && !isNaN(t)) ? new Date(t).toISOString().slice(0, 10) : ''; };
  const lines = [cols.join(',')];
  rows.forEach(e => {
    const p = m.proj[e.project_id];
    lines.push([
      e.voucher_no, e.date, e.details, m.cat[e.category_id] || '', p ? p.code : '',
      m.loc[e.location_id] || '', e.bill_received || '', e.payment_status || '',
      toRupees(e.amount), e.status, e.paid ? 'Yes' : 'No', dcell(e.paid_at),
      m.usr[e.created_by] || '',
    ].map(esc).join(','));
  });
  await logAudit(req.user, 'Exported CSV', 'report', '', rows.length + ' rows');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="site-expenses-${Date.now()}.csv"`);
  res.send('\ufeff' + lines.join('\n'));
});

//===============================================================================================================================
// Download one approved, unpaid payment with its payment data and attachments.
router.get('/payments/:id/download', requireRole('accounts_manager', 'admin'), async (req, res) => {
  const e = await db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id);

  if (!e) return res.status(404).json({ error: 'Payment not found' });

  if (
    e.status !== 'Approved' ||
    e.paid ||
    !canSeeExpense(req.user, e)
  ) {
    return res.status(403).json({ error: 'Payment is not available for download' });
  }

  const m = await nameMaps();
  const p = m.proj[e.project_id];

  const expense = {
    ...e,
    categoryName: m.cat[e.category_id] || '',
    locationName: m.loc[e.location_id] || '',
    createdByName: m.usr[e.created_by] || '',
    project: p || null,
  };

  await buildPaymentZip(res, [expense]);
});


// Download selected approved, unpaid payments with their payment data and attachments.
router.post('/payments/download', requireRole('accounts_manager', 'admin'), async (req, res) => {
  const ids = Array.isArray(req.body.ids)
    ? [...new Set(req.body.ids.map(String).filter(Boolean))]
    : [];

  if (!ids.length) {
    return res.status(400).json({ error: 'No vouchers selected' });
  }

  const m = await nameMaps();
  const expenses = [];

  for (const id of ids) {
    const e = await db.prepare('SELECT * FROM expenses WHERE id=?').get(id);

    if (!e) {
      return res.status(404).json({ error: 'One or more selected payments were not found' });
    }

    if (e.status !== 'Approved' || e.paid || !canSeeExpense(req.user, e)) {
      return res.status(403).json({
        error: `Payment ${e.voucher_no} is not available for download`
      });
    }

    const p = m.proj[e.project_id];

    expenses.push({
      ...e,
      categoryName: m.cat[e.category_id] || '',
      locationName: m.loc[e.location_id] || '',
      createdByName: m.usr[e.created_by] || '',
      project: p || null,
    });
  }

  await buildPaymentZip(res, expenses);
});

// Download selected vouchers that have completed the approval workflow.
router.post('/vouchers/download', requireRole('accounts_manager', 'admin'), async (req, res) => {
  const ids = Array.isArray(req.body.ids)
    ? [...new Set(req.body.ids.map(String).filter(Boolean))]
    : [];

  if (!ids.length) {
    return res.status(400).json({ error: 'No vouchers selected' });
  }

  const m = await nameMaps();
  const expenses = [];

  for (const id of ids) {
    const e = await db.prepare('SELECT * FROM expenses WHERE id=?').get(id);

    if (!e) {
      return res.status(404).json({ error: 'One or more selected vouchers were not found' });
    }

    if (!['Accounts Reviewed', 'Approved', 'Payment Approved', 'Paid'].includes(e.status) || !canSeeExpense(req.user, e)) {
      return res.status(403).json({
        error: `Voucher ${e.voucher_no} is not available for download`
      });
    }

    const p = m.proj[e.project_id];

    expenses.push({
      ...e,
      categoryName: m.cat[e.category_id] || '',
      locationName: m.loc[e.location_id] || '',
      createdByName: m.usr[e.created_by] || '',
      project: p || null,
    });
  }

  await buildPaymentZip(res, expenses);
});

// ================================================================ PAYMENTS

// Accounts confirms that payment has been processed.
// IMPORTANT:
// expenses.paid is NOT changed here.
// That field represents the creator's original Paid/Unpaid selection.
//
// Workflow:
// Approved -> Payment Approved
router.post('/payments', requireRole('accounts_manager', 'admin'), async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];

  if (!ids.length) {
    return res.status(400).json({ error: 'No vouchers selected' });
  }

  let confirmed = 0;

  for (const id of ids) {
    const e = await db.prepare(
      'SELECT * FROM expenses WHERE id=?'
    ).get(id);

    if (
      !e ||
      e.status !== 'Approved' ||
      !canSeeExpense(req.user, e)
    ) {
      continue;
    }

    const paymentTime = now();
    const paymentDate = new Date(paymentTime)
    .toISOString()
    .slice(0, 10);

    // IMPORTANT:
    // DO NOT change expenses.paid here.
    //
    // expenses.paid = creator's original Paid/Unpaid selection.
    //
    // status = company payment workflow.
    await db.prepare(`
      UPDATE expenses
      SET
        status='Payment Approved',
        payment_status='Payment Approved',
        paid_at=?,
        paid_by=?
      WHERE id=?
        AND status='Approved'
    `).run(
      paymentTime,
      req.user.id,
      id
    );

    await addHistory(
      id,
      req.user.id,
      'Payment approved',
      'Accounts confirmed payment; voucher is now eligible for fund request'
    );

    await logAudit(
      req.user,
      'Payment approved',
      'expense',
      e.voucher_no,
      '₹' + toRupees(e.amount)
    );

    confirmed++;
  }

  res.json({
    ok: true,
    paid: confirmed,
  });
});



// ================================================================ BUDGETS (#9 -- accounts/admin)
router.get('/budgets', requireRole('accounts_manager', 'admin'), async (req, res) => {
  const m = await nameMaps();
  const period = req.query.period || null;
  const rows = period
    ? await db.prepare('SELECT * FROM project_budgets WHERE period=? ORDER BY project_id').all(period)
    : await db.prepare('SELECT * FROM project_budgets ORDER BY period DESC, project_id').all();
  res.json(rows.map(b => ({
    id: b.id, projectId: b.project_id, code: (m.proj[b.project_id] || {}).code || '—',
    name: (m.proj[b.project_id] || {}).name || '', period: b.period, budget: toRupees(b.budget_amount),
  })));
});
router.post('/budgets', requireRole('accounts_manager', 'admin'), async (req, res) => {
  const { projectId, period, amount } = req.body;
  if (!projectId || !period || amount == null) return res.status(400).json({ error: 'Project, period and amount required' });
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Period must be YYYY-MM' });
  const existing = await db.prepare('SELECT id FROM project_budgets WHERE project_id=? AND period=?').get(projectId, period);
  if (existing) {
    await db.prepare('UPDATE project_budgets SET budget_amount=?,updated_at=? WHERE id=?').run(toPaise(amount), now(), existing.id);
  } else {
    await db.prepare('INSERT INTO project_budgets (id,project_id,period,budget_amount,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(uid(), projectId, period, toPaise(amount), req.user.id, now(), now());
  }
  await logAudit(req.user, 'Set project budget', 'budget', projectId, `${period}: ₹${amount}`);
  res.json({ ok: true });
});
router.delete('/budgets/:id', requireRole('accounts_manager', 'admin'), async (req, res) => {
  const b = await db.prepare('SELECT * FROM project_budgets WHERE id=?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  await db.prepare('DELETE FROM project_budgets WHERE id=?').run(req.params.id);
  await logAudit(req.user, 'Removed project budget', 'budget', b.project_id, b.period);
  res.json({ ok: true });
});

router.get('/analytics', requireRole('accounts_manager', 'admin'), async (req, res) => {
  const m = await nameMaps();
  const SPEND = "status NOT IN ('Draft','Rejected')";
  const byCategory = (await db.prepare(`SELECT category_id, SUM(amount) v, COUNT(*) c FROM expenses WHERE ${SPEND} GROUP BY category_id ORDER BY v DESC`)
    .all()).map(r => ({ name: m.cat[r.category_id] || 'Uncategorised', amount: toRupees(r.v), count: r.c }));
  const byProject = (await db.prepare(`SELECT project_id, SUM(amount) v, COUNT(*) c FROM expenses WHERE ${SPEND} GROUP BY project_id ORDER BY v DESC`)
    .all()).map(r => ({ code: (m.proj[r.project_id] || {}).code || '—', name: (m.proj[r.project_id] || {}).name || '', amount: toRupees(r.v), count: r.c }));
  const byStatus = (await db.prepare('SELECT status, SUM(amount) v, COUNT(*) c FROM expenses GROUP BY status').all())
    .map(r => ({ status: r.status, amount: toRupees(r.v), count: r.c }));
  const st = s => { const r = byStatus.find(x => x.status === s); return r ? r.amount : 0; };
  const totalRow = await db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE ${SPEND}`).get();
  const total = toRupees(totalRow.v);
  const approved = st('Approved');
  const paidRow = await db.prepare('SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE paid=1').get();
  const paid = toRupees(paidRow.v);
  const totals = { total, approved, paid, pending: total - approved, rejected: st('Rejected') };
  const byMonth = (await db.prepare(`SELECT substr(date,1,7) ym, SUM(amount) v FROM expenses WHERE ${SPEND} AND date IS NOT NULL GROUP BY ym ORDER BY ym DESC LIMIT 6`)
    .all()).reverse().map(r => ({ month: r.ym, amount: toRupees(r.v) }));

  // ---- money health ----
  const users = {}; (await db.prepare('SELECT id,name,role FROM users').all()).forEach(u => users[u.id] = u);
  const spentByUser = {}; (await db.prepare(`SELECT COALESCE(site_user_id,created_by) site_user_id, SUM(amount) v FROM expenses WHERE ${SPEND} GROUP BY COALESCE(site_user_id,created_by)`).all()).forEach(r => spentByUser[r.site_user_id] = toRupees(r.v));
  const releasedRow = await db.prepare(`
    SELECT COALESCE(SUM(f.amount),0) v
    FROM funds f
    WHERE f.kind='allocation' AND f.to_user IS NOT NULL
  `).get();
  const released = toRupees(releasedRow.v);
  const allocationBySite = (await db.prepare("SELECT to_user, SUM(amount) v FROM funds WHERE kind='allocation' GROUP BY to_user").all())
    .filter(r => r.to_user).map(r => { const allocRs = toRupees(r.v), sp = spentByUser[r.to_user] || 0; return { name: (users[r.to_user] || {}).name || '—', allocated: allocRs, spent: sp, balance: allocRs - sp }; })
    .sort((a, b) => b.allocated - a.allocated);
  const monthsActive = Math.max(1, byMonth.length);
  const avgMonthlyBurn = total / monthsActive;
  const burn = { released, spent: total, remaining: released - total, avgMonthlyBurn, runwayMonths: avgMonthlyBurn > 0 ? (released - total) / avgMonthlyBurn : null };
  const unpaidRows = (await db.prepare("SELECT project_id, SUM(amount) v FROM expenses WHERE status='Approved' AND COALESCE(paid,0)=0 GROUP BY project_id ORDER BY v DESC").all())
    .map(r => ({ ...r, v: toRupees(r.v) }));
  const unpaidByProject = unpaidRows.map(r => ({ code: (m.proj[r.project_id] || {}).code || '—', name: (m.proj[r.project_id] || {}).name || '', amount: r.v }));
  const unpaidTotal = unpaidRows.reduce((a, b) => a + b.v, 0);

  // ---- budget vs actual, current month (#9) ----
  const curMonth = new Date().toISOString().slice(0, 7);
  const spendThisMonth = {};
  (await db.prepare(`SELECT project_id, SUM(amount) v FROM expenses
    WHERE ${SPEND}
      AND category_id IN (SELECT id FROM categories WHERE LOWER(name) IN ('food','lpg','water'))
      AND substr(date,1,7)=? GROUP BY project_id`).all(curMonth))
    .forEach(r => spendThisMonth[r.project_id] = toRupees(r.v));
  const budgetVsActual = (await db.prepare('SELECT project_id, budget_amount FROM project_budgets WHERE period=?').all(curMonth))
    .map(b => {
      const p = m.proj[b.project_id] || {}, budgetRs = toRupees(b.budget_amount), incurred = spendThisMonth[b.project_id] || 0;
      return { code: p.code || '—', name: p.name || '', period: curMonth, budget: budgetRs, incurred, variance: budgetRs - incurred, pctUsed: budgetRs > 0 ? +(incurred / budgetRs * 100).toFixed(1) : null };
    });

  // ---- workflow speed (iterate vouchers once) ----
  const rows = await db.prepare('SELECT id,status,amount,created_by,submitted_at,created_at,approvals,date FROM expenses').all();
  const DAY = 86400000;
  const acc = { check: { t: 0, n: 0 }, purchase: { t: 0, n: 0 }, operations: { t: 0, n: 0 }, accounts: { t: 0, n: 0 }, approved: { t: 0, n: 0 } };
  const cleared = {};
  rows.forEach(e => {
    let ap = {}; try { ap = JSON.parse(e.approvals || '{}'); } catch (x) {}
    const anchor = e.submitted_at || e.created_at, at = k => ap[k] && ap[k].at;
    if (at('check') && anchor) { acc.check.t += at('check') - anchor; acc.check.n++; }
    if (at('purchase') && at('check')) { acc.purchase.t += at('purchase') - at('check'); acc.purchase.n++; }
    if (at('operations') && at('purchase')) { acc.operations.t += at('operations') - at('purchase'); acc.operations.n++; }
    if (at('accounts') && at('operations')) { acc.accounts.t += at('accounts') - at('operations'); acc.accounts.n++; }
    if (at('approved') && at('accounts')) { acc.approved.t += at('approved') - at('accounts'); acc.approved.n++; }
    ['check', 'purchase', 'operations', 'accounts', 'approved'].forEach(k => { if (ap[k] && ap[k].by) cleared[ap[k].by] = (cleared[ap[k].by] || 0) + 1; });
  });
  const stageLabel = { check: 'Submit → General Manager', purchase: 'General Manager → Project Director / Incharge', operations: 'Project Director / Incharge → Senior Accountant', accounts: 'Senior Accountant → Accounts Manager / Head', approved: 'Accounts Manager / Head → Approved' };
  const turnaround = ['check', 'purchase', 'operations', 'accounts', 'approved'].map(k => ({ stage: stageLabel[k], avgDays: acc[k].n ? +(acc[k].t / acc[k].n / DAY).toFixed(1) : 0, count: acc[k].n }));
  const throughput = Object.entries(cleared).map(([id, c]) => ({ name: (users[id] || {}).name || '—', role: (users[id] || {}).role || '', cleared: c })).sort((a, b) => b.cleared - a.cleared);

  // ---- SLA + aging (pending vouchers) ----
  const pendingStatuses = ['Submitted', 'Checked', 'Purchase Reviewed', 'Operations Reviewed', 'Accounts Reviewed', 'Query'];
  let onTrack = 0, overdue = 0; const aging = { '< 2 days': 0, '2–7 days': 0, '> 7 days': 0 };
  for (const e of rows.filter(e => pendingStatuses.includes(e.status))) {
    const sla = await computeSla(e);
    if (sla && Date.now() > sla.dueAt) overdue++; else onTrack++;
    const ageD = (Date.now() - (e.submitted_at || e.created_at || Date.now())) / DAY;
    if (ageD < 2) aging['< 2 days']++; else if (ageD <= 7) aging['2–7 days']++; else aging['> 7 days']++;
  }
  const agingArr = Object.entries(aging).map(([bucket, count]) => ({ bucket, count }));

  res.json({ byCategory, byProject, byStatus, totals, byMonth, allocationBySite, burn, unpaidByProject, unpaidTotal, budgetVsActual, turnaround, throughput, sla: { onTrack, overdue }, aging: agingArr });
});

// P30 -- Audit Trail is admin-only (Accounts no longer has access)
router.get('/audit', requireRole('admin'), async (req, res) => {
  res.json(await db.prepare('SELECT * FROM audit ORDER BY at DESC LIMIT 500').all());
});

router.get(
  '/fund-requests/eligible',
  requireRole('senior_accountant', 'admin'),
  async (req, res) => {
    const m = await nameMaps();
    const sc = scopeClause(req.user, 'e');

    const params = [...sc.params];

    const rows = await db.prepare(`
      SELECT
        e.*
      FROM expenses e
      WHERE e.status = 'Payment Approved'
        ${sc.where}
        AND NOT EXISTS (
          SELECT 1
          FROM fund_request_items fri
          JOIN fund_requests fr
            ON fr.id = fri.fund_request_id
          WHERE fri.expense_id = e.id
            AND fr.status NOT IN ('Completed', 'Cancelled')
        )
      ORDER BY e.date DESC, e.created_at DESC
    `).all(...params);

    const result = rows.map(e => ({
      ...e,
      projectCode: m.proj[e.project_id]?.code || '',
      projectName: m.proj[e.project_id]?.name || '',
      locationName: m.loc[e.location_id] || '',
      categoryName: m.cat[e.category_id] || '',
      createdByName: m.usr[e.created_by] || '',
      siteUserName: m.usr[e.site_user_id || e.created_by] || '',
      amount: toRupees(e.amount)
    }));

    res.json(result);
  }
);

router.get(
  '/fund-requests',
  requireRole('project_director', 'senior_accountant', 'site_accounts', 'admin', 'accounts_manager'),
  async (req, res) => {
    const scope = scopeOf(req.user);
    const projectScopeSql = scope.all ? '' : scope.ids.length
      ? `AND NOT EXISTS (SELECT 1 FROM fund_request_items fri_scope JOIN expenses e_scope ON e_scope.id=fri_scope.expense_id WHERE fri_scope.fund_request_id=fr.id AND e_scope.project_id NOT IN (${scope.ids.map(() => '?').join(',')}))`
      : 'AND 1=0';
    const params = [...scope.ids];
    let scopeSql = projectScopeSql;
    if (req.user.role === 'site_accounts') {
      scopeSql += " AND fr.status='Released' AND fr.site_user_id=?";
      params.push(req.user.id);
    }
    const rows = await db.prepare(`
      SELECT
        fr.*,
        u.name AS created_by_name,
        su.name AS site_user_name,
        COUNT(fri.id) AS item_count
      FROM fund_requests fr
      JOIN users u
        ON u.id = fr.created_by
      LEFT JOIN users su
        ON su.id = fr.site_user_id
      LEFT JOIN fund_request_items fri
        ON fri.fund_request_id = fr.id
      WHERE 1=1 ${scopeSql}
      GROUP BY fr.id, u.name, su.name
      ORDER BY fr.created_at DESC
    `).all(...params);

    res.json(rows.map(r => ({
      ...r,
      total: toRupees(r.total_amount),
      itemCount: Number(r.item_count || 0),
    })));
  }
);

router.get(
  '/fund-requests/:id',
  requireRole('project_director', 'senior_accountant', 'site_accounts', 'admin', 'accounts_manager'),
  async (req, res) => {
      const request = await db.prepare(`
        SELECT
          fr.*,
          u.name AS created_by_name,
          su.name AS site_user_name
        FROM fund_requests fr
        JOIN users u
          ON u.id = fr.created_by
        LEFT JOIN users su
          ON su.id = fr.site_user_id
      WHERE fr.id = ?
    `).get(req.params.id);

    if (!request) {
      return res.status(404).json({
        error: 'Fund request not found'
      });
    }

    const m = await nameMaps();

    const items = await db.prepare(`
      SELECT
        fri.id AS item_id,
        fri.amount AS requested_amount,
        e.*
      FROM fund_request_items fri
      JOIN expenses e
        ON e.id = fri.expense_id
      WHERE fri.fund_request_id = ?
      ORDER BY e.date DESC, e.created_at DESC
    `).all(req.params.id);
    if (items.some(e => !canSeeExpense(req.user, e))) {
      return res.status(403).json({ error: 'Fund request is outside your project access' });
    }
    if (req.user.role === 'site_accounts' && (request.status !== 'Released' || request.site_user_id !== req.user.id)) {
      return res.status(404).json({ error: 'Released fund request not found for this Site Accounts user' });
    }

    const itemsWithHistory = await Promise.all(
      items.map(async (e) => {
        const historyRows = await db.prepare(`
          SELECT
            eh.*,
            u.name AS by_name
          FROM expense_history eh
          LEFT JOIN users u
            ON u.id = eh.by_user
          WHERE eh.expense_id = ?
          ORDER BY eh.at ASC
        `).all(e.id);

        return {
          ...e,

          history: historyRows.map(h => ({
            ...h,
            byName: h.by_name || '—'
          }))
        };
      })
    );

    res.json({
    ...request,
    total: toRupees(request.total_amount),

    items: itemsWithHistory.map(e => {
      let approvals = {};

      try {
        approvals = JSON.parse(e.approvals || '{}');
      } catch (_) {
        approvals = {};
      }

      return {
        ...e,

        amount: toRupees(e.requested_amount),

        projectCode:
          m.proj[e.project_id]?.code || '',

        projectName:
          m.proj[e.project_id]?.name || '',

        locationName:
          m.loc[e.location_id] || '',

        siteUserName:
          m.usr[e.site_user_id || e.created_by] || '',

        voucherPrintedByName:
          e.voucher_printed_by ? m.usr[e.voucher_printed_by] || '' : '',

        categoryName:
          m.cat[e.category_id] || '',

        createdByName:
          m.usr[e.created_by] || '',

        approvalNames: {
          accounts:
            approvals.accounts?.by
              ? m.usr[approvals.accounts.by] || ''
              : '',

          purchase:
            approvals.purchase?.by
              ? m.usr[approvals.purchase.by] || ''
              : '',

          operations:
            approvals.operations?.by
              ? m.usr[approvals.operations.by] || ''
              : '',
        },
      };
    })
  });
});

router.post(
  '/fund-requests/:id/print',
  requireRole('senior_accountant', 'admin'),
  async (req, res) => {
    const result = await db.transaction(async () => {
      const request = await db.prepare(`
        SELECT *
        FROM fund_requests
        WHERE id = ?
        FOR UPDATE
      `).get(req.params.id);

      if (!request) {
        throw new Error('Fund request not found');
      }

      if (!['Requested', 'Printed'].includes(request.status)) {
        throw new Error(`Only Requested fund requests can be printed (current status: ${request.status})`);
      }

      const printedAt = now();

      await db.prepare(`
        UPDATE fund_requests
        SET
          printed_at = ?,
          printed_by = ?,
          status = 'Printed'
        WHERE id = ?
      `).run(
        printedAt,
        req.user.id,
        request.id
      );

      await logAudit(
        req.user,
        'Printed fund request',
        'fund_request',
        request.request_no,
        `Fund request paperwork printed`
      );

      return {
        printedAt,
        status: 'Printed'
      };
    });

    res.json({
      ok: true,
      ...result
    });
  }
);

router.post(
  '/fund-requests/:id/vouchers/:expenseId/mark-printed',
  requireRole('senior_accountant', 'admin'),
  async (req, res) => {
    const result = await db.transaction(async () => {
      const request = await db.prepare('SELECT * FROM fund_requests WHERE id=? FOR UPDATE').get(req.params.id);
      if (!request) throw new Error('Fund request not found');
      if (request.status !== 'Printed') throw new Error('Mark the fund request as printed before marking its vouchers');

      const expense = await db.prepare(`
        SELECT e.* FROM expenses e
        JOIN fund_request_items fri ON fri.expense_id=e.id
        WHERE fri.fund_request_id=? AND e.id=?
        FOR UPDATE
      `).get(request.id, req.params.expenseId);
      if (!expense) throw new Error('Voucher is not part of this fund request');
      if (expense.status !== 'Payment Approved') throw new Error(`Voucher ${expense.voucher_no} is no longer eligible for printing`);
      if (!canSeeExpense(req.user, expense)) throw new Error('Voucher is outside your project access');
      if (expense.voucher_printed_at) {
        return { alreadyPrinted: true, printedAt: expense.voucher_printed_at, printedBy: expense.voucher_printed_by };
      }

      const printedAt = now();
      await db.prepare('UPDATE expenses SET voucher_printed_at=?,voucher_printed_by=?,updated_at=? WHERE id=? AND voucher_printed_at IS NULL')
        .run(printedAt, req.user.id, printedAt, expense.id);
      await addHistory(expense.id, req.user.id, 'Voucher marked printed', `Printed as part of fund request ${request.request_no}`);
      await logAudit(req.user, 'Marked voucher printed', 'expense', expense.voucher_no, `Fund request ${request.request_no}`);
      return { alreadyPrinted: false, printedAt, printedBy: req.user.id, voucherNo: expense.voucher_no };
    });
    res.json({ ok: true, ...result });
  }
);

router.post(
  '/fund-requests',
  requireRole('senior_accountant', 'admin'),
  async (req, res) => {
    const ids = Array.isArray(req.body.ids)
      ? [...new Set(req.body.ids.map(String).filter(Boolean))]
      : [];
    const siteUserId = String(req.body.siteUserId || '').trim();

    if (!ids.length) {
      return res.status(400).json({
        error: 'No vouchers selected'
      });
    }

    if (!siteUserId) {
      return res.status(400).json({ error: 'Select the Site Accounts user who will receive these funds' });
    }

    const result = await db.transaction(async () => {
      const placeholders = ids.map(() => '?').join(',');

      const expenses = await db.prepare(`
        SELECT *
        FROM expenses
        WHERE id IN (${placeholders})
          AND status = 'Payment Approved'
        FOR UPDATE
      `).all(...ids);

      if (expenses.length !== ids.length) {
        throw new Error(
          'One or more selected vouchers are no longer available for fund request'
        );
      }

      const siteUser = await loadUser(siteUserId);
      if (!siteUser || siteUser.role !== 'site_accounts' || !siteUser.active) {
        throw new Error('The selected recipient must be an active Site Accounts user');
      }
      const projectIds = [...new Set(expenses.map(e => e.project_id))];
      for (const e of expenses) {
        let ownerId = e.site_user_id;
        if (!ownerId) {
          const creator = await loadUser(e.created_by);
          if (creator && creator.role === 'site_accounts') ownerId = creator.id;
        }
        if (ownerId !== siteUserId) throw new Error(`Voucher ${e.voucher_no} is not assigned to the selected Site Accounts user`);
      }
      if (!siteUser.all_projects && projectIds.some(pid => !(siteUser.project_ids || []).includes(pid))) {
        throw new Error('The selected Site Accounts user is not assigned to every project in this request');
      }

      for (const e of expenses) {
        const existing = await db.prepare(`
          SELECT fri.id
          FROM fund_request_items fri
          JOIN fund_requests fr
            ON fr.id = fri.fund_request_id
          WHERE fri.expense_id = ?
            AND fr.status NOT IN ('Completed', 'Cancelled')
          LIMIT 1
        `).get(e.id);

        if (existing) {
          throw new Error(
            `Voucher ${e.voucher_no} is already included in a fund request`
          );
        }
      }

      const requestId = uid();
      const requestNo = await nextFundRequest();
      const createdAt = now();

      const total = expenses.reduce(
        (sum, e) => sum + Number(e.amount || 0),
        0
      );

      await db.prepare(`
        INSERT INTO fund_requests
          (
            id,
            request_no,
            created_by,
            created_at,
            status,
            total_amount,
            site_user_id
          )
        VALUES (?, ?, ?, ?, 'Requested', ?, ?)
      `).run(
        requestId,
        requestNo,
        req.user.id,
        createdAt,
        total,
        siteUserId
      );

      for (const e of expenses) {
        await db.prepare(`
          INSERT INTO fund_request_items
            (
              id,
              fund_request_id,
              expense_id,
              amount
            )
          VALUES (?, ?, ?, ?)
        `).run(
          uid(),
          requestId,
          e.id,
          e.amount
        );
      }

      for (const e of expenses) {
        await addHistory(
          e.id,
          req.user.id,
          'Fund requested',
          `Included in ${requestNo}`
        );
      }

      await logAudit(
        req.user,
        'Created fund request',
        'fund_request',
        requestNo,
        `${expenses.length} voucher(s) · ₹${toRupees(total)}`
      );

      return {
        id: requestId,
        requestNo,
        count: expenses.length,
        total: toRupees(total)
      };
    });

    res.json({
      ok: true,
      ...result
    });
  }
);

// ================================================================
// FUND REQUEST RELEASE
//
// Senior Accountant prints; Accounts Manager / Head releases. The assigned Site Accounts user then
// confirms receipt, which credits their balance and completes the request.
// Workflow: Payment Approved -> Requested -> Printed -> Released -> Completed.

router.post(
  '/fund-requests/:id/release',
  requireRole('accounts_manager', 'admin'),
  async (req, res) => {
    const result = await db.transaction(async () => {

      // Lock the fund request so two Accounts users cannot
      // release the same request simultaneously.
      const request = await db.prepare(`
        SELECT *
        FROM fund_requests
        WHERE id = ?
        FOR UPDATE
      `).get(req.params.id);

      if (!request) {
        throw new Error('Fund request not found');
      }

      if (request.status !== 'Printed') {
        throw new Error(
          `Only Printed fund requests can be released (current status: ${request.status})`
        );
      }
      const recipient = request.site_user_id ? await loadUser(request.site_user_id) : null;
      if (!recipient || recipient.role !== 'site_accounts' || !recipient.active) {
        throw new Error('The Site Accounts recipient is missing or inactive');
      }

      // Get all vouchers belonging to this request.
      const items = await db.prepare(`
        SELECT
          fri.id AS item_id,
          fri.amount AS requested_amount,
          e.*
        FROM fund_request_items fri
        JOIN expenses e
          ON e.id = fri.expense_id
        WHERE fri.fund_request_id = ?
        FOR UPDATE
      `).all(request.id);

      if (!items.length) {
        throw new Error('Fund request contains no vouchers');
      }

      // Make sure every voucher is still valid.
      for (const e of items) {
        if (e.status !== 'Payment Approved') {
          throw new Error(
            `${e.voucher_no} is no longer Payment Approved`
          );
        }

        if (!canSeeExpense(req.user, e)) {
          throw new Error(
            `Voucher ${e.voucher_no} is outside your project access`
          );
        }
        if ((e.site_user_id || e.created_by) !== recipient.id) {
          throw new Error(`Voucher ${e.voucher_no} does not belong to the selected Site Accounts recipient`);
        }
      }

      const releasedAt = now();
      for (const e of items) {
        await addHistory(
          e.id,
          req.user.id,
          'Funds released',
          `Fund request ${request.request_no} released; awaiting confirmation from ${recipient.name}`
        );
        await logAudit(req.user, 'Funds released pending receipt', 'expense', e.voucher_no, `Fund request ${request.request_no} · ₹${toRupees(e.amount)}`);
      }

      await db.prepare(`
        UPDATE fund_requests
        SET
          status = 'Released',
          released_at = ?,
          released_by = ?
        WHERE id = ?
          AND status = 'Printed'
      `).run(
        releasedAt,
        req.user.id,
        request.id
      );

      await logAudit(
        req.user,
        'Released fund request',
        'fund_request',
        request.request_no,
        `₹${toRupees(request.total_amount)} · ${items.length} voucher(s); awaiting receipt confirmation by ${recipient.name}`
      );

      return {
        requestNo: request.request_no,
        total: toRupees(request.total_amount),
        count: items.length,
        releasedAt
      };
    });

    res.json({
      ok: true,
      ...result
    });
  }
);

router.post('/fund-requests/:id/confirm-receipt', requireRole('site_accounts'), async (req, res) => {
  const result = await db.transaction(async () => {
    const request = await db.prepare('SELECT * FROM fund_requests WHERE id=? FOR UPDATE').get(req.params.id);
    if (!request) throw new Error('Fund request not found');
    if (request.status !== 'Released') throw new Error(`Only Released requests can be receipt-confirmed (current status: ${request.status})`);
    if (!request.site_user_id) throw new Error('Fund request has no Site Accounts recipient');
    if (request.site_user_id !== req.user.id) throw new Error('Only the assigned Site Accounts user can confirm receipt');

    const recipient = await loadUser(request.site_user_id);
    if (!recipient || recipient.role !== 'site_accounts' || !recipient.active) throw new Error('Fund request recipient is not an active Site Accounts user');
    const items = await db.prepare(`
      SELECT fri.amount requested_amount, e.*
      FROM fund_request_items fri JOIN expenses e ON e.id=fri.expense_id
      WHERE fri.fund_request_id=? FOR UPDATE
    `).all(request.id);
    if (!items.length) throw new Error('Fund request contains no vouchers');
    for (const e of items) {
      if (e.status !== 'Payment Approved') throw new Error(`${e.voucher_no} is no longer Payment Approved`);
      if (!canSeeExpense(req.user, e)) throw new Error(`Voucher ${e.voucher_no} is outside your project access`);
      if ((e.site_user_id || e.created_by) !== recipient.id) throw new Error(`Voucher ${e.voucher_no} is assigned to another Site Accounts user`);
      if (!recipient.all_projects && !(recipient.project_ids || []).includes(e.project_id)) throw new Error('The Site Accounts recipient is not assigned to every project in this request');
    }

    const receivedAt = now();
    for (const e of items) {
      const project = await db.prepare('SELECT id FROM projects WHERE id=?').get(e.project_id);
      await db.prepare(`
        INSERT INTO funds (id,project_id,amount,date,note,added_by,created_at,kind,to_user)
        VALUES (?,?,?,?,?,?,?,'allocation',?)
      `).run(uid(), project.id, e.requested_amount, new Date(receivedAt).toISOString().slice(0, 10), `Received ${request.request_no} · ${e.voucher_no}`, req.user.id, receivedAt, recipient.id);
      await db.prepare(`
        UPDATE expenses SET status='Paid', payment_status='Paid', paid_at=?, paid_by=?, updated_at=?
        WHERE id=? AND status='Payment Approved'
      `).run(String(receivedAt), req.user.id, receivedAt, e.id);
      await addHistory(e.id, req.user.id, 'Funds received', `Confirmed receipt for ${request.request_no}; credited to ${recipient.name}`);
      await logAudit(req.user, 'Confirmed fund receipt', 'expense', e.voucher_no, `₹${toRupees(e.requested_amount)} credited to ${recipient.name}`);
    }
    await db.prepare(`
      UPDATE fund_requests SET status='Completed', receipt_confirmed_at=?, receipt_confirmed_by=?
      WHERE id=? AND status='Released'
    `).run(receivedAt, req.user.id, request.id);
    await logAudit(req.user, 'Confirmed fund request receipt', 'fund_request', request.request_no, `₹${toRupees(request.total_amount)} credited to ${recipient.name}`);
    return { requestNo: request.request_no, total: toRupees(request.total_amount), siteUserName: recipient.name, receivedAt };
  });
  res.json({ ok: true, ...result });
});

module.exports = router;
