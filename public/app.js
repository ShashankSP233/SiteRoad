"use strict";
/* ============ helpers ============ */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) =>
  String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const money = (n) =>
  "₹" + (Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

function amountInWordsIndian(amount) {
  const n = Math.round(Number(amount) || 0);

  if (n === 0) return "Zero Rupees Only";

  const ones = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
  ];

  const tens = [
    "",
    "",
    "Twenty",
    "Thirty",
    "Forty",
    "Fifty",
    "Sixty",
    "Seventy",
    "Eighty",
    "Ninety",
  ];

  function under100(n) {
    if (n < 20) return ones[n];
    return tens[Math.floor(n / 10)] + (n % 10 ? " " + ones[n % 10] : "");
  }

  function under1000(n) {
    if (n < 100) return under100(n);

    return (
      ones[Math.floor(n / 100)] +
      " Hundred" +
      (n % 100 ? " " + under100(n % 100) : "")
    );
  }

  function indian(n) {
    const parts = [];

    const crore = Math.floor(n / 10000000);
    n %= 10000000;

    const lakh = Math.floor(n / 100000);
    n %= 100000;

    const thousand = Math.floor(n / 1000);
    n %= 1000;

    if (crore) parts.push(under100(crore) + " Crore");
    if (lakh) parts.push(under100(lakh) + " Lakh");
    if (thousand) parts.push(under100(thousand) + " Thousand");
    if (n) parts.push(under1000(n));

    return parts.join(" ");
  }

  return indian(n) + " Rupees Only";
}


const fmtDate = (d) =>
  d
    ? new Date(d).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";
const fmtDT = (ts) => {
  const x = new Date(ts);
  return (
    x.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) +
    " " +
    x.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  );
};
function toast(msg, type) {
  const t = $("#toast");
  t.className = "toast show " + (type || "");
  t.textContent = msg;
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.className = "toast"), 2600);
}

const ROLES = {
  admin: "Administrator",
  site: "Site Person",
  checker: "Checker",
  purchase: "Purchase Reviewer",
  operations: "Operations Reviewer",
  accounts: "Accounts Manager",
  account_checker: "Account Checker",
};
const PILL = {
  Draft: "p-draft",
  Submitted: "p-sub",
  Checked: "p-chk",
  "Purchase Reviewed": "p-pur",
  "Operations Reviewed": "p-ops",
  "Accounts Reviewed": "p-acc",
  Approved: "p-app",
  "Payment Approved": "p-app",
  Printed: "p-app",
  Paid: "p-app",
  Completed: "p-app",
  Query: "p-qry",
  Rejected: "p-rej",
};

const pill = (s) =>
  `<span class="pill ${PILL[s] || "p-draft"}">${esc(s)}</span>`;

const S = {
  user: null,
  projects: [],
  allProjects: [],
  categories: [],
  locations: [],
  users: [],
  page: "dashboard",
};
const userName = (id) => (S.users.find((u) => u.id === id) || {}).name || "—";

/* ============ api ============ */
async function api(method, path, body, isForm) {
  const opt = { method, credentials: "same-origin", headers: {} };
  if (isForm) opt.body = body;
  else if (body != null) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const r = await fetch("/api" + path, opt);
  if (r.status === 401) {
    showLogin();
    throw new Error("Session expired");
  }
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) {
    const err = new Error((data && data.error) || "HTTP " + r.status);
    err.data = data;
    err.status = r.status;
    throw err;
  }
  return data;
}

/* ============ auth / boot ============ */
function showLogin() {
  $("#login").classList.remove("hide");
  $("#app").classList.add("hide");
}
async function doLogin() {
  $("#lg-err").textContent = "";
  try {
    await api("POST", "/login", {
      username: $("#lg-user").value.trim(),
      password: $("#lg-pass").value,
    });
    await boot();
  } catch (e) {
    $("#lg-err").textContent = e.message;
  }
}
async function logout() {
  try {
    await api("POST", "/logout");
  } catch (e) {}
  location.reload();
}

// re-pull active categories/locations/projects after masters change so forms stay current
async function refreshLookups() {
  try {
    const d = await api("GET", "/bootstrap");
    S.categories = d.categories;
    S.locations = d.locations;
    S.projects = d.projects;
    S.allProjects = d.allProjects;
  } catch (e) {}
}

async function boot() {
  const d = await api("GET", "/bootstrap");
  Object.assign(S, {
    user: d.user,
    projects: d.projects,
    allProjects: d.allProjects,
    categories: d.categories,
    locations: d.locations,
    users: d.users,
  });
  $("#login").classList.add("hide");
  $("#app").classList.remove("hide");
  $("#who").innerHTML =
    `<div class="nm">${esc(S.user.name)}</div><div class="rl">${ROLES[S.user.role]}</div><div class="logout" onclick="UsersAdmin.changePassword()">Change Password</div><div class="logout" onclick="logout()">⎋ Sign out</div>`;
  await buildNav();
  go(S.page);
}

/* ============ navigation ============ */
const can = {
  create: () => ["site", "checker", "admin"].includes(S.user.role),
  review: () =>
    ["checker", "purchase", "operations", "accounts", "account_checker", "admin"].includes(
      S.user.role,
    ),
  admin: () => S.user.role === "admin",
  accountCheckers: () => ["accounts", "admin"].includes(S.user.role),
  audit: () => S.user.role === "admin",
  addFunds: () => ["admin", "accounts"].includes(S.user.role),
  payments: () => ["accounts", "admin"].includes(S.user.role),
  downloadVouchers: () => ["accounts", "admin"].includes(S.user.role),

  // New Fund Request workflow
  allFundRequests: () => ["admin", "accounts"].includes(S.user.role),
  fundRequests: () => S.user.role === "admin",
  fundRequestsPurchase: () => S.user.role === "purchase",
  fundsRelease: () => S.user.role === "accounts",

  analytics: () => ["accounts", "admin"].includes(S.user.role),
  funds: () => ["site", "checker", "accounts", "admin"].includes(S.user.role),
  reports: () =>
    ["accounts", "admin"].includes(S.user.role),
  reviewTab: () => can.review() && S.user.role !== "checker",
  reviewOnly: () => ["purchase", "operations"].includes(S.user.role),
};

function pendingForMe(list) {
  const r = S.user.role;
  if (r === "checker") return list.filter((e) => e.status === "Submitted");
  if (r === "purchase") return list.filter((e) => e.status === "Checked");
  if (r === "operations")
    return list.filter((e) => e.status === "Purchase Reviewed");
  if (r === "accounts")
    return list.filter((e) =>
      ["Operations Reviewed", "Accounts Reviewed"].includes(e.status),
    );
  if (r === "account_checker")
    return list.filter((e) => e.status === "Operations Reviewed");
  if (r === "admin")
    return list.filter((e) =>
      [
        "Submitted",
        "Checked",
        "Purchase Reviewed",
        "Operations Reviewed",
        "Accounts Reviewed",
      ].includes(e.status),
    );
  return [];
}
async function buildNav() {
  let pend = 0;
  if (can.reviewTab()) {
    try {
      pend = pendingForMe(await api("GET", "/expenses")).length;
    } catch (e) {}
  }
  const items = [];
  if (!can.reviewOnly())
    items.push(
      { grp: "Overview" },
      { id: "dashboard", ic: "▦", label: "Dashboard" },
      { id: "expenses", ic: "☰", label: "All Expenses" },
    );
  if (can.reviewTab())
    items.push({
      id: "review",
      ic: "✓",
      label: "Review Queue",
      badge: pend || "",
    });

  if (can.fundRequestsPurchase())
    items.push({
      id: "fundRequestsPurchase",
      ic: "₹",
      label: "Fund Requests",
    });

  if (can.fundsRelease())
    items.push({
      id: "fundsRelease",
      ic: "₹",
      label: "Funds Release",
    });

  if (can.allFundRequests())
  items.push({
    id: "allFundRequests",
    ic: "₹",
    label: "All Fund Requests",
  });

  if (can.funds())
    items.push({ id: "funds", ic: "₹", label: "Funds & Balance" });
  if (can.reports())
    items.push(
      { grp: "Reports" },
      { id: "reports", ic: "⤓", label: "Reports & Export" },
    );
  if (can.payments())
    items.push({ id: "payments", ic: "✔", label: "Approved Payments" });
  if (can.downloadVouchers())
    items.push({ id: "downloadVouchers", ic: "⇩", label: "Download Vouchers" });
  if (can.fundRequests())
    items.push({
      id: "fundRequests",
      ic: "₹",
      label: "Fund Request",
    });
  if (can.analytics())
    items.push({ id: "analytics", ic: "📊", label: "Analytics" });
  if (can.admin() || can.audit() || S.user.role === "accounts") {
    items.push({ grp: "Administration" });
    if (S.user.role === "accounts")
      items.push({ id: "accountCheckers", ic: "◎", label: "Account Checkers" });
    if (can.admin())
      items.push({ id: "users", ic: "◎", label: "Users & Access" });
    if (can.admin()) items.push({ id: "masters", ic: "⚙", label: "Masters" });
    if (can.audit()) items.push({ id: "audit", ic: "⌗", label: "Audit Trail" });
  }
  $("#nav").innerHTML = items
    .map((it) =>
      it.grp
        ? `<div class="group">${it.grp}</div>`
        : `<a data-pg="${it.id}" onclick="go('${it.id}')"><span>${it.ic}</span><span>${it.label}</span>${it.badge ? `<span class="badge">${it.badge}</span>` : ""}</a>`,
    )
    .join("");

  const bn = [];
  if (!can.reviewOnly())
    bn.push(
      { id: "dashboard", ic: "▦", label: "Home" },
      { id: "expenses", ic: "☰", label: "Expenses" },
    );
  if (can.create()) bn.push({ id: "__new", ic: "+", label: "New", add: true });
  if (can.reviewTab())
    bn.push({ id: "review", ic: "✓", label: "Review", badge: pend || "" });
  if (can.fundRequestsPurchase())
    bn.push({
      id: "fundRequestsPurchase",
      ic: "₹",
      label: "Requests",
    });
  if (can.fundsRelease())
    bn.push({
      id: "fundsRelease",
      ic: "₹",
      label: "Release",
    });
    
  if (can.funds()) bn.push({ id: "funds", ic: "₹", label: "Balance" });
  if (can.payments()) bn.push({ id: "payments", ic: "✔", label: "Pay" });
  if (can.downloadVouchers())
    bn.push({ id: "downloadVouchers", ic: "⇩", label: "Vouchers" });
  $("#botnav").innerHTML = bn
    .map(
      (it) =>
        `<a data-pg="${it.id}" class="${it.add ? "add" : ""}" onclick="${it.add ? "ExpenseForm.open()" : `go('${it.id}')`}"><span class="ic">${it.ic}</span><span>${it.label}</span>${it.badge ? `<span class="badge">${it.badge}</span>` : ""}</a>`,
    )
    .join("");
}
const TITLES = {
  dashboard: ["Dashboard", "Overview of site expenses"],
  expenses: ["All Expenses", "Every recorded voucher"],
  review: ["Review Queue", "Items awaiting your action"],
  funds: ["Funds & Balance", "Money given vs spent per project"],
  reports: ["Reports & Export", "Filter and download CSV"],
  fundRequests: [
    "Fund Request",
    "Select Payment Approved vouchers and request funds",
  ],

  fundRequestsPurchase: [
    "Fund Requests",
    "Requests awaiting paperwork and Accounts processing",
  ],

  fundsRelease: [
    "Funds Release",
    "Release funds for printed fund requests",
  ],
  allFundRequests: [
    "All Fund Requests",
    "Complete history of fund requests",
  ],
  users: ["Users & Access", "Accounts, roles & project access"],
  accountCheckers: ["Account Checkers", "Manage Account Checker access"],
  masters: ["Masters", "Categories, projects & locations"],
  audit: ["Audit Trail", "Complete activity log"],
  payments: ["Approved Payments", "Select approved vouchers to pay"],
  downloadVouchers: ["Download Vouchers", "Select vouchers that completed Accounts review"],
  paymentReceived: [
    "Payment Received",
    "Confirm payments received after Accounts approval",
  ],
  analytics: ["Analytics", "Spend comparisons & trends"],
};

async function go(pg) {
  if (
    can.reviewOnly() &&
    pg !== "review" &&
    !(S.user.role === "purchase" && pg === "fundRequestsPurchase")
  ) {
    pg = "review";
  } 

  S.page = pg;
  $$("#nav a").forEach((a) =>
    a.classList.toggle("active", a.dataset.pg === pg),
  );
  $$("#botnav a").forEach((a) =>
    a.classList.toggle("active", a.dataset.pg === pg),
  );
  $("#side").classList.remove("open");
  $("#topActions").innerHTML = "";
  const t = TITLES[pg] || ["", ""];
  $("#pageTitle").textContent = t[0];
  $("#pageCrumb").textContent = t[1];
  $("#content").innerHTML = '<div class="empty">Loading…</div>';
  try {
    await Views[pg]();
  } catch (e) {
    $("#content").innerHTML =
      `<div class="card card-pad"><div class="empty">${esc(e.message)}</div></div>`;
  }
}

/* ============ modal ============ */
const Modal = {
  open(html) {
    $("#modalRoot").innerHTML =
      `<div class="modal-bg" onclick="if(event.target===this)Modal.close()"><div class="modal">${html}</div></div>`;
  },
  close() {
    $("#modalRoot").innerHTML = "";
  },
};

/* ============ shared table ============ */
function slaBadge(e) {
  if (!e.sla || !e.sla.dueAt) return "";
  const left = e.sla.dueAt - Date.now();
  const d = Math.ceil(left / 86400000);
  if (left < 0) {
    const over = Math.max(1, Math.floor(-left / 86400000));
    return `<span class="tag" style="background:#fdecea;color:#c0392b" title="${esc(e.sla.label)} overdue">⏰ Overdue ${over}d</span>`;
  }
  const soon = d <= 1;
  return `<span class="tag" style="background:${soon ? "#fff3e0" : "#eef0f3"};color:${soon ? "#b9770e" : "#5b6472"}" title="${esc(e.sla.label)} due">⏳ ${d}d left</span>`;
}

function previousDelayBadge(e) {
  const delays = e.previousDelays || [];
  if (!delays.length) return '';

  const names = delays.map(d => d.stage).join(', ');
  const label = delays.length === 1
    ? `Previously delayed — ${delays[0].stage}`
    : `Previously delayed — ${delays.length} review stages`;

  return `<span class="tag"
    style="background:#fff3e0;color:#b9770e"
    title="${esc(names)}">
    ⚠ Previously delayed
  </span>`;
}

function overallSlaBadge(e) {
  if (!e.overallSla || !e.overallSla.dueAt) return '';

  if (e.overallSla.overdue) {
    const over = Math.max(
      1,
      Math.floor((Date.now() - e.overallSla.dueAt) / 86400000)
    );

    return `<span class="tag"
      style="background:#fdecea;color:#c0392b"
      title="Overall requisition age exceeded 7 days">
      ⚠ Requisition overdue ${over}d
    </span>`;
  }

  return '';
}

function expenseTable(rows, opts) {
  opts = opts || {};
  const showReviewActions = opts.reviewActions === true;
  if (!rows.length) return '<div class="empty">No matching expenses.</div>';
  return `<div class="table-wrap"><table><thead><tr><th>Voucher</th><th>Date</th><th>Details</th><th>Category</th><th>Project</th><th class="num">Amount</th><th>Status</th>${showReviewActions ? "<th>Actions</th>" : ""}</tr></thead><tbody>${rows.map((e) => `<tr class="click" onclick="Detail.open('${e.id}')"><td class="mono">${esc(e.voucher_no)}</td><td>${fmtDate(e.date)}</td><td>${esc((e.details || "").slice(0, 42))}${(e.details || "").length > 42 ? "…" : ""} ${e.evidenceCount ? `<span class="tag">📎${e.evidenceCount}</span>` : ""}${e.paid ? ' <span class="tag">💰 Paid</span>' : ""} ${previousDelayBadge(e)} ${overallSlaBadge(e)} ${slaBadge(e)}</td><td><span class="tag">${esc(e.categoryName)}</span></td><td>${esc(e.projectCode)}</td><td class="num">${money(e.amount)}</td><td>${pill(e.status)}</td>${showReviewActions ? `<td>${e.status === "Accounts Reviewed" ? `<div class="queue-actions" onclick="event.stopPropagation()"><button class="btn btn-primary btn-sm" style="background:var(--green)" onclick="Detail.advance('${e.id}','approve')">Accept</button><button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="Detail.reject('${e.id}')">Reject</button><button class="btn btn-ghost btn-sm" onclick="Detail.raiseQuery('${e.id}')">Query</button></div>` : ""}</td>` : ""}</tr>`).join("")}</tbody></table></div>`;
}

/* ============ views ============ */
const Views = {};
Views.dashboard = async function () {
  const [ex, fundsData, fundRequests] = await Promise.all([
    api("GET", "/expenses"),
    can.funds() ? api("GET", "/funds") : Promise.resolve({ totals: {} }),
    S.user.role === "accounts" ? api("GET", "/fund-requests") : Promise.resolve([]),
  ]);
  const total = ex.reduce((s, e) => s + (+e.amount || 0), 0);
  const totalApproved = fundRequests
    .filter(
      (r) =>
        ["Printed", "Completed"].includes(r.status) &&
        !String(r.request_no || "").trim().toUpperCase().startsWith("APR"),
    )
    .reduce((s, r) => s + (+r.total || 0), 0);
  const totalPaid = fundRequests
    .filter((r) => r.status === "Completed")
    .reduce((s, r) => s + (+r.total || 0), 0);
  // P5/18 — "In Review" reflects only vouchers that currently have an active (open) query
  const inReview = ex.filter((e) => e.status === "Query").length;
  // P3/16 — dashboard lists only not-yet-approved vouchers, with queried ones pinned on top
  const pending = ex
    .filter((e) => !["Approved", "Rejected"].includes(e.status))
    .slice()
    .sort((a, b) => {
      const qa = a.status === "Query" ? 0 : 1,
        qb = b.status === "Query" ? 0 : 1;
      return qa !== qb ? qa - qb : (b.created_at || 0) - (a.created_at || 0);
    });
  const t = fundsData.totals; // role-aware ledger: {received, spent, balance, [distributed]}
  const role = S.user.role;
  const given = t.received || 0,
    balance = role === "accounts" ? totalPaid - totalApproved : t.balance || 0,
    spent = t.spent || 0;
  const recvLbl =
    role === "site"
      ? "allocated to this site"
      : role === "checker"
        ? "received from accounts"
        : "released to projects";
  const balSub =
    role === "accounts"
      ? `${money(totalPaid)} paid − ${money(totalApproved)} approved`
      : role === "checker"
      ? `${money(t.distributed || 0)} to sites`
      : `${money(spent)} spent`;
  $("#content").innerHTML = `
    <div class="grid stat-row" style="margin-bottom:20px">
      <div class="stat accent"><div class="lab">Total Expenses</div><div class="val">${money(total)}</div><div class="sub2">${ex.length} vouchers</div></div>
      <div class="stat green"><div class="lab">${role === "accounts" ? "Total Approved" : "Funds Received"}</div><div class="val">${money(role === "accounts" ? totalApproved : given)}</div><div class="sub2">${role === "accounts" ? "printed or completed" : recvLbl}</div></div>
      ${role === "accounts" ? `<div class="stat accent"><div class="lab">Total Paid</div><div class="val">${money(totalPaid)}</div><div class="sub2">completed fund requests</div></div>` : ""}
      <div class="stat blue"><div class="lab">Balance In Hand</div><div class="val" style="color:${balance >= 0 ? "var(--green)" : "var(--red)"}">${money(balance)}</div><div class="sub2">${balSub}</div></div>
      ${role !== "accounts" ? `<div class="stat amber"><div class="lab">In Review</div><div class="val">${inReview}</div><div class="sub2">active queries</div></div>` : ""}
    </div>
    <div class="card"><div class="card-pad" style="display:flex;align-items:center;border-bottom:1px solid var(--line)"><div><h3>Pending Vouchers</h3><div class="csub" style="margin:0">Not yet approved · queries shown first</div></div><button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="go('expenses')">View all →</button></div>${expenseTable(pending)}</div>`;
  if (can.create())
    $("#topActions").innerHTML =
      `<button class="btn btn-primary" onclick="ExpenseForm.open()">+ New Expense</button>`;
};

const CHART_PALETTE = [
  "#4f7cff",
  "#22a06b",
  "#e0a400",
  "#8b5cf6",
  "#0ea5e9",
  "#e5484d",
  "#14b8a6",
  "#f97316",
  "#6366f1",
  "#84cc16",
];
function fmtMonth(ym) {
  if (!ym) return "—";
  const p = String(ym).split("-");
  const n = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return (n[+p[1] - 1] || p[1]) + " " + p[0];
}
function barChart(rows, opts) {
  opts = opts || {};
  if (!rows.length) return '<div class="empty">No data yet.</div>';
  const fmt = opts.fmt || money;
  const max = Math.max(1, ...rows.map((r) => r.value || 0));
  return (
    '<div style="display:flex;flex-direction:column;gap:10px">' +
    rows
      .map((r, i) => {
        const pct = Math.max(1.5, ((r.value || 0) / max) * 100);
        const color = r.color || CHART_PALETTE[i % CHART_PALETTE.length];
        return `<div style="display:flex;align-items:center;gap:10px">
      <div style="width:132px;flex:0 0 132px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(r.label)}">${esc(r.label)}</div>
      <div style="flex:1;background:var(--line);border-radius:6px;height:22px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${color};border-radius:6px"></div></div>
      <div style="width:118px;flex:0 0 118px;text-align:right;font-size:13px;font-variant-numeric:tabular-nums">${fmt(r.value || 0)}${opts.count && r.count != null ? ` <span style="color:var(--muted,#8a8a8a)">(${r.count})</span>` : ""}</div>
    </div>`;
      })
      .join("") +
    "</div>"
  );
}
function utilisationChart(rows) {
  if (!rows.length) return '<div class="empty">No allocations yet.</div>';
  const max = Math.max(1, ...rows.map((r) => r.allocated || 0));
  return (
    '<div style="display:flex;flex-direction:column;gap:10px">' +
    rows
      .map((r) => {
        const barW = Math.max(1.5, ((r.allocated || 0) / max) * 100);
        const fillW =
          r.allocated > 0
            ? Math.min(100, ((r.spent || 0) / r.allocated) * 100)
            : 0;
        const over = (r.spent || 0) > (r.allocated || 0);
        return `<div style="display:flex;align-items:center;gap:10px">
      <div style="width:120px;flex:0 0 120px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(r.name)}">${esc(r.name)}</div>
      <div style="flex:1;background:var(--line);border-radius:6px;height:22px;overflow:hidden"><div style="width:${barW}%;height:100%;background:#dbe4ff;border-radius:6px"><div style="width:${fillW}%;height:100%;background:${over ? "#e5484d" : "#4f7cff"};border-radius:6px"></div></div></div>
      <div style="width:158px;flex:0 0 158px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums">${money(r.spent)} / ${money(r.allocated)} · <span style="color:${r.balance >= 0 ? "var(--green)" : "var(--red)"}">${money(r.balance)}</span></div>
    </div>`;
      })
      .join("") +
    "</div>"
  );
}
Views.analytics = async function () {
  const d = await api("GET", "/analytics");
  const t = d.totals,
    b = d.burn;
  const sva = [
    { label: "Total (committed)", value: t.total, color: "#4f7cff" },
    { label: "Approved", value: t.approved, color: "#22a06b" },
    { label: "Paid", value: t.paid, color: "#0ea5e9" },
    { label: "Pending", value: t.pending, color: "#e0a400" },
    { label: "Rejected", value: t.rejected, color: "#e5484d" },
  ];
  const catRows = d.byCategory.map((c) => ({
    label: c.name,
    value: c.amount,
    count: c.count,
  }));
  const projRows = d.byProject.map((p) => ({
    label: (p.code ? p.code + " · " : "") + p.name,
    value: p.amount,
    count: p.count,
  }));
  const monthRows = d.byMonth.map((mo) => ({
    label: fmtMonth(mo.month),
    value: mo.amount,
  }));
  const cnt = (v) => String(v);
  const num = (v) => (v == null ? "—" : (+v).toFixed(1));
  const card = (title, sub, body) =>
    `<div class="card" style="margin-bottom:18px"><div class="card-pad" style="border-bottom:1px solid var(--line)"><h3>${title}</h3>${sub ? `<div class="csub" style="margin:0">${sub}</div>` : ""}</div><div style="padding:16px">${body}</div></div>`;
  $("#content").innerHTML =
    `<h3 style="margin:2px 0 12px;color:var(--muted,#666)">Spend</h3>` +
    card(
      "Actual vs Approved Spend",
      "Where the money sits across the workflow",
      barChart(sva),
    ) +
    card(
      "Spend by Category",
      "Submitted vouchers (excludes drafts & rejected)",
      barChart(catRows, { count: true }),
    ) +
    card(
      "Spend by Site / Project",
      "Submitted vouchers (excludes drafts & rejected)",
      barChart(projRows, { count: true }),
    ) +
    card(
      "Monthly Spend",
      "Last 6 months, by expense date",
      barChart(monthRows),
    ) +
    `<h3 style="margin:22px 0 12px;color:var(--muted,#666)">Money health</h3>` +
    `<div class="grid stat-row" style="margin-bottom:18px">
       <div class="stat green"><div class="lab">Funds Released</div><div class="val">${money(b.released)}</div></div>
       <div class="stat accent"><div class="lab">Spent</div><div class="val">${money(b.spent)}</div></div>
       <div class="stat blue"><div class="lab">Remaining</div><div class="val" style="color:${b.remaining >= 0 ? "var(--green)" : "var(--red)"}">${money(b.remaining)}</div><div class="sub2">~${money(b.avgMonthlyBurn)}/mo · runway ${b.runwayMonths == null ? "—" : num(b.runwayMonths) + " mo"}</div></div>
     </div>` +
    card(
      "Allocation Utilisation by Site",
      "Spent within allocation (red bar = over-allocated)",
      utilisationChart(d.allocationBySite),
    ) +
    card(
      "Unpaid Outflow — " + money(d.unpaidTotal),
      "Approved but not yet paid, by project",
      barChart(
        d.unpaidByProject.map((p) => ({
          label: (p.code ? p.code + " · " : "") + p.name,
          value: p.amount,
        })),
      ),
    ) +
    `<div class="card" style="margin-bottom:18px"><div class="card-pad" style="display:flex;align-items:center;border-bottom:1px solid var(--line)"><div><h3>Budget vs Actual — ${fmtMonth(new Date().toISOString().slice(0, 7))}</h3><div class="csub" style="margin:0">Incurred spend within this month's budget (red bar = over budget)</div></div><button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="BudgetsAdmin.set()">+ Set Budget</button></div><div style="padding:16px">${
      d.budgetVsActual.length
        ? utilisationChart(
            d.budgetVsActual.map((x) => ({
              name: (x.code ? x.code + " · " : "") + x.name,
              allocated: x.budget,
              spent: x.incurred,
              balance: x.variance,
            })),
          )
        : '<div class="empty">No budgets set for this month yet.</div>'
    }</div></div>` +
    `<h3 style="margin:22px 0 12px;color:var(--muted,#666)">Workflow speed</h3>` +
    card(
      "Approval Turnaround by Stage",
      "Average days at each step",
      barChart(
        d.turnaround.map((s) => ({
          label: s.stage,
          value: s.avgDays,
          count: s.count,
        })),
        { fmt: (v) => v + " d", count: true },
      ),
    ) +
    card(
      "SLA Status",
      "Pending vouchers: on time vs overdue",
      barChart(
        [
          { label: "On track", value: d.sla.onTrack, color: "#22a06b" },
          { label: "Overdue", value: d.sla.overdue, color: "#e5484d" },
        ],
        { fmt: cnt },
      ),
    ) +
    card(
      "Pending Aging",
      "How long pending vouchers have waited",
      barChart(
        d.aging.map((a) => ({ label: a.bucket, value: a.count })),
        { fmt: cnt },
      ),
    ) +
    card(
      "Throughput per Approver",
      "Approval actions cleared",
      barChart(
        d.throughput.map((x) => ({
          label:
            x.name + (x.role && ROLES[x.role] ? " · " + ROLES[x.role] : ""),
          value: x.cleared,
        })),
        { fmt: cnt },
      ),
    );
};
Views.payments = async function () {
  const ex = await api("GET", "/expenses");
  const list = ex.filter((e) => e.status === "Approved");
  const total = list.reduce((s, e) => s + (+e.amount || 0), 0);
  const rows =
    list
      .map(
        (e) => `<tr>
      <td><input type="checkbox" class="pay-cb" value="${e.id}"></td>
      <td class="mono">${esc(e.voucher_no)}</td><td>${fmtDate(e.date)}</td>
      <td>${esc((e.details || "").slice(0, 40))}</td><td>${esc(e.projectCode)}</td>
      <td class="num">${money(e.amount)}</td>
      <td>
        <button class="btn btn-ghost btn-sm" onclick="Detail.open('${e.id}')">View</button>
      
      </td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="7"><div class="empty">No approved vouchers awaiting payment.</div></td></tr>';
  $("#content").innerHTML = `
    <div class="card"><div class="card-pad" style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)">
      <div>
        <h3>Approved Payments</h3>
        <div class="csub" style="margin:0">
          ${list.length} voucher(s) awaiting payment · ${money(total)}
        </div>
      </div>

      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost" onclick="Views._downloadSelectedPayments()">
          Download Selected
        </button>
        <button class="btn btn-primary" onclick="Views._confirmPay()">
          Confirm Payment
        </button>
      </div>
    </div>
    <div class="table-wrap"><table><thead><tr><th><input type="checkbox" onclick="Views._toggleAllPay(this)"></th><th>Voucher</th><th>Date</th><th>Details</th><th>Project</th><th class="num">Amount</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
};

Views.downloadVouchers = async function () {
  const ex = await api("GET", "/expenses");
  Views._downloadVouchers = ex.filter((e) =>
    ["Accounts Reviewed", "Approved", "Payment Approved", "Paid"].includes(e.status),
  );

  const projects = [
    ...new Map(
      Views._downloadVouchers
        .filter((e) => e.project_id)
        .map((e) => [e.project_id, { id: e.project_id, code: e.projectCode }]),
    ).values(),
  ];

  const statuses = [...new Set(Views._downloadVouchers.map((e) => e.status))];
  const projectOptions = projects
    .sort((a, b) => String(a.code).localeCompare(String(b.code)))
    .map((p) => `<option value="${esc(p.id)}">${esc(p.code || "—")}</option>`)
    .join("");
  const statusOptions = statuses
    .sort()
    .map((status) => `<option value="${esc(status)}">${esc(status)}</option>`)
    .join("");

  $("#content").innerHTML = `
    <div class="card card-pad" style="margin-bottom:16px">
      <div class="toolbar">
        <input id="dv-q" placeholder="Search voucher / details…" oninput="Views._filterDownloadVouchers()">
        <select id="dv-project" onchange="Views._filterDownloadVouchers()"><option value="">All projects</option>${projectOptions}</select>
        <select id="dv-status" onchange="Views._filterDownloadVouchers()"><option value="">All completed statuses</option>${statusOptions}</select>
        <input id="dv-from" type="date" title="From date" onchange="Views._filterDownloadVouchers()">
        <input id="dv-to" type="date" title="To date" onchange="Views._filterDownloadVouchers()">
        <button class="btn btn-primary" onclick="Views._downloadSelectedVouchers()">Download Selected</button>
      </div>
      <div id="dv-count" class="csub" style="margin:0 0 12px"></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th><input type="checkbox" onclick="Views._toggleAllDownloadVouchers(this)"></th><th>Voucher</th><th>Date</th><th>Details</th><th>Project</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
          <tbody id="dv-body"></tbody>
        </table>
      </div>
    </div>`;

  Views._filterDownloadVouchers();
};

Views._filterDownloadVouchers = function () {
  let rows = Views._downloadVouchers || [];
  const q = ($("#dv-q")?.value || "").trim().toLowerCase();
  const project = $("#dv-project")?.value || "";
  const status = $("#dv-status")?.value || "";
  const from = $("#dv-from")?.value || "";
  const to = $("#dv-to")?.value || "";

  if (q) {
    rows = rows.filter((e) =>
      [e.voucher_no, e.details, e.projectCode]
        .map((value) => String(value || "").toLowerCase())
        .some((value) => value.includes(q)),
    );
  }
  if (project) rows = rows.filter((e) => String(e.project_id) === project);
  if (status) rows = rows.filter((e) => e.status === status);
  if (from) rows = rows.filter((e) => String(e.date || "") >= from);
  if (to) rows = rows.filter((e) => String(e.date || "") <= to);

  const total = rows.reduce((sum, e) => sum + (+e.amount || 0), 0);
  $("#dv-count").textContent = `${rows.length} voucher(s) · ${money(total)}`;
  $("#dv-body").innerHTML = rows
    .map(
      (e) => `<tr>
        <td><input type="checkbox" class="dv-cb" value="${esc(e.id)}"></td>
        <td class="mono">${esc(e.voucher_no)}</td>
        <td>${fmtDate(e.date)}</td>
        <td>${esc((e.details || "").slice(0, 40))}</td>
        <td>${esc(e.projectCode || "—")}</td>
        <td class="num">${money(e.amount)}</td>
        <td>${pill(e.status)}</td>
        <td><button class="btn btn-ghost btn-sm" onclick="Detail.open('${e.id}')">View</button></td>
      </tr>`,
    )
    .join("") || '<tr><td colspan="8"><div class="empty">No completed vouchers match these filters.</div></td></tr>';
};

Views._toggleAllDownloadVouchers = function (master) {
  $$(".dv-cb").forEach((cb) => {
    cb.checked = master.checked;
  });
};

Views.fundRequests = async function () {
  const list = await api("GET", "/fund-requests/eligible");

  const projects = [
    ...new Map(
      list
        .filter((e) => e.project_id)
        .map((e) => [
          e.project_id,
          {
            id: e.project_id,
            code: e.projectCode,
            name: e.projectName,
          },
        ]),
    ).values(),
  ];

  const locations = [
    ...new Map(
      list
        .filter((e) => e.location_id)
        .map((e) => [
          e.location_id,
          {
            id: e.location_id,
            name: e.locationName,
          },
        ]),
    ).values(),
  ];

  $("#content").innerHTML = `
    <div class="card card-pad" style="margin-bottom:16px">
      <div class="toolbar">
        <input
          id="fr-q"
          placeholder="Search voucher / details…"
          oninput="Views._filterFundRequests()"
        >

        <select id="fr-project" onchange="Views._filterFundRequests()">
          <option value="">All Projects</option>
          ${projects
            .map(
              (p) =>
                `<option value="${esc(p.id)}">${esc(p.code)} · ${esc(p.name)}</option>`,
            )
            .join("")}
        </select>

        <select id="fr-location" onchange="Views._filterFundRequests()">
          <option value="">All Sites / Locations</option>
          ${locations
            .map(
              (l) =>
                `<option value="${esc(l.id)}">${esc(l.name)}</option>`,
            )
            .join("")}
        </select>

        <div class="spacer"></div>

        <span id="fr-count" class="csub" style="margin:0"></span>
      </div>
    </div>

    <div class="card">
      <div
        class="card-pad"
        style="
          display:flex;
          align-items:center;
          justify-content:space-between;
          border-bottom:1px solid var(--line);
        "
      >
        <div>
          <h3>Eligible Vouchers</h3>
          <div class="csub" style="margin:0">
            Payment Approved vouchers not yet included in an active fund request
          </div>
        </div>

        <button
          class="btn btn-primary"
          onclick="Views._createFundRequest()"
        >
          Release Funds
        </button>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  onclick="Views._toggleAllFundRequests(this)"
                >
              </th>
              <th>Voucher</th>
              <th>Date</th>
              <th>Details</th>
              <th>Project</th>
              <th>Site / Location</th>
              <th class="num">Amount</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>

          <tbody id="fr-body"></tbody>
        </table>
      </div>
    </div>
  `;

  Views._fundRequests = list;
  Views._filterFundRequests();
};

Views.fundRequestsPurchase = async function () {
  const requests = await api("GET", "/fund-requests");

  const active = requests.filter(
    (r) => !["Completed", "Cancelled"].includes(r.status),
  );

  const rows =
    active
      .map(
        (r) => `
          <tr>
            <td>
              <input
                type="checkbox"
                class="frp-cb"
                value="${esc(r.id)}"
              >
            </td>

            <td class="mono">
              <b>${esc(r.request_no)}</b>
            </td>

            <td>
              ${fmtDate(Number(r.created_at))}
            </td>

            <td>
              ${esc(r.created_by_name || "—")}
            </td>

            <td class="num">
              ${r.item_count || 0}
            </td>

            <td class="num">
              ${money(r.total)}
            </td>

            <td>
              ${pill(r.status)}
            </td>

            <td>
              <button
                class="btn btn-ghost btn-sm"
                onclick="Views._openFundRequest('${esc(r.id)}')"
              >
                View
              </button>
            </td>
          </tr>
        `,
      )
      .join("") ||
    `
      <tr>
        <td colspan="8">
          <div class="empty">
            No fund requests are currently awaiting processing.
          </div>
        </td>
      </tr>
    `;

  $("#content").innerHTML = `
    <div class="card">
      <div
        class="card-pad"
        style="
          display:flex;
          align-items:center;
          justify-content:space-between;
          border-bottom:1px solid var(--line);
        "
      >
        <div>
          <h3>Fund Requests</h3>
          <div class="csub" style="margin:0">
            Requests created by Admin for Payment Approved vouchers
          </div>
        </div>

        <div style="display:flex;gap:8px">
          <button
            class="btn btn-ghost"
            onclick="Views._printSelectedFundRequests()"
          >
            Print Selected
          </button>
        </div>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  onclick="Views._toggleAllFundRequestsPurchase(this)"
                >
              </th>
              <th>Request</th>
              <th>Created</th>
              <th>Created By</th>
              <th class="num">Vouchers</th>
              <th class="num">Total</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>

          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    </div>
  `;
};

Views.allFundRequests = async function () {
  const requests = await api("GET", "/fund-requests");

  const rows =
    requests
      .map(
        (r) => `
          <tr>
            <td class="mono">
              <b>${esc(r.request_no || r.requestNo || "—")}</b>
            </td>

            <td>
              ${fmtDate(Number(r.created_at))}
            </td>

            <td>
              ${esc(
                r.created_by_name ||
                r.createdByName ||
                "—"
              )}
            </td>

            <td class="num">
              ${r.item_count || r.itemCount || 0}
            </td>

            <td class="num">
              ${money(r.total)}
            </td>

            <td>
              ${pill(r.status)}
            </td>

            <td>
              <button
                class="btn btn-ghost btn-sm"
                onclick="Views._openFundRequest('${esc(r.id)}')"
              >
                View
              </button>
            </td>
          </tr>
        `,
      )
      .join("") ||
    `
      <tr>
        <td colspan="7">
          <div class="empty">
            No fund requests found.
          </div>
        </td>
      </tr>
    `;

  $("#content").innerHTML = `
    <div class="card">
      <div
        class="card-pad"
        style="
          display:flex;
          align-items:center;
          justify-content:space-between;
          border-bottom:1px solid var(--line);
        "
      >
        <div>
          <h3>All Fund Requests</h3>
          <div class="csub" style="margin:0">
            Complete history of fund requests
          </div>
        </div>

        <div class="tag">
          ${requests.length} request${requests.length === 1 ? "" : "s"}
        </div>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Request</th>
              <th>Created</th>
              <th>Created By</th>
              <th class="num">Vouchers</th>
              <th class="num">Total</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>

          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    </div>
  `;
};


Views.fundsRelease = async function () {
  const requests = await api("GET", "/fund-requests");

  const printed = requests.filter(
    (r) => r.status === "Printed"
  );

  const rows =
    printed
      .map(
        (r) => `
          <tr>
            <td class="mono">
              <b>${esc(r.request_no || r.requestNo || "—")}</b>
            </td>

            <td>
              ${fmtDate(Number(r.created_at))}
            </td>

            <td>
              ${esc(
                r.created_by_name ||
                r.createdByName ||
                "—"
              )}
            </td>

            <td class="num">
              ${r.item_count || r.itemCount || 0}
            </td>

            <td class="num">
              ${money(r.total)}
            </td>

            <td>
              ${pill(r.status)}
            </td>

            <td>
              <button
                class="btn btn-ghost btn-sm"
                onclick="Views._openFundRequestRelease('${esc(r.id)}')"
              >
                View
              </button>

              <button
                class="btn btn-primary btn-sm"
                onclick="Views._releaseFundRequest('${esc(r.id)}')"
              >
                Payment Released
              </button>
            </td>
          </tr>
        `
      )
      .join("") ||
    `
      <tr>
        <td colspan="7">
          <div class="empty">
            No printed fund requests are awaiting payment release.
          </div>
        </td>
      </tr>
    `;

  $("#content").innerHTML = `
    <div class="card">

      <div
        class="card-pad"
        style="
          display:flex;
          align-items:center;
          justify-content:space-between;
          border-bottom:1px solid var(--line);
        "
      >
        <div>
          <h3>Funds Release</h3>

          <div class="csub" style="margin:0">
            Printed fund requests awaiting actual payment
          </div>
        </div>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Request</th>
              <th>Created</th>
              <th>Created By</th>
              <th class="num">Vouchers</th>
              <th class="num">Total</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>

          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>

    </div>
  `;
};

Views._openFundRequestRelease = async function (id) {
  try {
    const dl = (k, v) =>
      `<div class="dl">${k}</div><div class="dv">${v}</div>`;

    const r = await api(
      "GET",
      `/fund-requests/${encodeURIComponent(id)}`
    );

    const items = r.items || [];

    const itemRows =
      items
        .map(
          (e) => `
            <tr>
              <td class="mono">${esc(e.voucher_no)}</td>
              <td>${fmtDate(e.date)}</td>
              <td>${esc(e.details || "—")}</td>
              <td>${esc(e.projectCode || "—")}</td>
              <td>${esc(e.locationName || "—")}</td>
              <td class="num">${money(e.amount)}</td>
            </tr>
          `
        )
        .join("") ||
      `
        <tr>
          <td colspan="6">
            <div class="empty">
              No vouchers in this request.
            </div>
          </td>
        </tr>
      `;

    Modal.open(`
      <div class="modal-head">
        <h3>${esc(r.request_no || r.requestNo)}</h3>
        ${pill(r.status)}
        <button class="x" onclick="Modal.close()">×</button>
      </div>

      <div class="modal-body">

        <div class="detail-grid">
          ${dl(
            "Request",
            esc(r.request_no || r.requestNo || "—")
          )}

          ${dl(
            "Created",
            fmtDT(Number(r.created_at))
          )}

          ${dl(
            "Created By",
            esc(
              r.created_by_name ||
              r.createdByName ||
              "—"
            )
          )}

          ${dl(
            "Vouchers",
            String(items.length)
          )}

          ${dl(
            "Total",
            `<b class="mono">${money(r.total)}</b>`
          )}

          ${dl(
            "Status",
            pill(r.status)
          )}
        </div>

        <div class="section-t">
          Vouchers
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Voucher</th>
                <th>Date</th>
                <th>Details</th>
                <th>Project</th>
                <th>Site</th>
                <th class="num">Amount</th>
              </tr>
            </thead>

            <tbody>
              ${itemRows}
            </tbody>
          </table>
        </div>

        <div
          style="
            display:flex;
            justify-content:flex-end;
            gap:8px;
            margin-top:18px;
          "
        >

          <button
            class="btn btn-ghost"
            onclick="Modal.close()"
          >
            Cancel
          </button>

          <button
            class="btn btn-primary"
            onclick="Views._releaseFundRequest('${esc(r.id)}')"
          >
            Payment Released
          </button>

        </div>

      </div>
    `);

  } catch (e) {
    toast(e.message, "err");
  }
};

Views._releaseFundRequest = async function (id) {
  try {
    const r = await api(
      "GET",
      `/fund-requests/${encodeURIComponent(id)}`
    );

    const requestNo = r.request_no || r.requestNo;
    const total = Number(r.total || r.total_amount || 0);
    const count = (r.items || []).length;

    if (
      !confirm(
        `Release payment for ${requestNo}?\n\n` +
        `${count} voucher(s)\n` +
        `${money(total)}\n\n` +
        `This will mark the vouchers Paid and deposit the released amount into the project fund pool.`
      )
    ) {
      return;
    }

    const result = await api(
      "POST",
      `/fund-requests/${encodeURIComponent(id)}/release`
    );

    Modal.close();

    toast(
      `${result.requestNo} released · ${money(result.total)} · ${result.count} voucher(s)`,
      "ok"
    );

    go("fundsRelease");

  } catch (e) {
    toast(e.message, "err");
  }
};

Views._filterFundRequests = function () {
  let rows = Views._fundRequests || [];

  const q = ($("#fr-q").value || "").trim().toLowerCase();
  const project = $("#fr-project").value;
  const location = $("#fr-location").value;

  if (q) {
    rows = rows.filter(
      (e) =>
        (e.voucher_no || "").toLowerCase().includes(q) ||
        (e.details || "").toLowerCase().includes(q),
    );
  }

  if (project) {
    rows = rows.filter((e) => String(e.project_id) === String(project));
  }

  if (location) {
    rows = rows.filter((e) => String(e.location_id) === String(location));
  }

  const total = rows.reduce(
    (sum, e) => sum + (+e.amount || 0),
    0,
  );

  $("#fr-count").textContent =
    `${rows.length} voucher(s) · ${money(total)}`;

  $("#fr-body").innerHTML =
    rows
      .map(
        (e) => `
          <tr>
            <td>
              <input
                type="checkbox"
                class="fr-cb"
                value="${esc(e.id)}"
              >
            </td>

            <td class="mono">${esc(e.voucher_no)}</td>

            <td>${fmtDate(e.date)}</td>

            <td>
              ${esc((e.details || "").slice(0, 42))}
            </td>

            <td>
              ${esc(e.projectCode || "—")}
            </td>

            <td>
              ${esc(e.locationName || "—")}
            </td>

            <td class="num">
              ${money(e.amount)}
            </td>

            <td>
              ${pill(e.status)}
            </td>

            <td>
              <button
                class="btn btn-ghost btn-sm"
                onclick="Detail.open('${e.id}')"
              >
                View
              </button>
            </td>
          </tr>
        `,
      )
      .join("") ||
    `
      <tr>
        <td colspan="9">
          <div class="empty">
            No Payment Approved vouchers are currently available for a fund request.
          </div>
        </td>
      </tr>
    `;
};

Views._toggleAllFundRequests = function (master) {
  $$(".fr-cb").forEach((cb) => {
    cb.checked = master.checked;
  });
};

Views._createFundRequest = async function () {
  const ids = $$(".fr-cb")
    .filter((cb) => cb.checked)
    .map((cb) => cb.value);

  if (!ids.length) {
    toast("Select at least one voucher", "err");
    return;
  }

  const selected = (Views._fundRequests || []).filter((e) =>
    ids.includes(e.id),
  );

  const total = selected.reduce(
    (sum, e) => sum + (+e.amount || 0),
    0,
  );

  if (
    !confirm(
      `Create a Fund Request for ${ids.length} voucher(s) totaling ${money(total)}?`,
    )
  ) {
    return;
  }

  try {
    const r = await api("POST", "/fund-requests", { ids });

    toast(
      `${r.requestNo} created · ${money(r.total)} · ${r.count} voucher(s)`,
      "ok",
    );

    go("fundRequests");
  } catch (e) {
    toast(e.message, "err");
  }
};

Views._toggleAllFundRequestsPurchase = function (master) {
  $$(".frp-cb").forEach((cb) => {
    cb.checked = master.checked;
  });
};

Views._openFundRequest = async function (id) {
  try {
    const dl = (k, v) =>
      `<div class="dl">${k}</div><div class="dv">${v}</div>`;

    const r = await api(
      "GET",
      `/fund-requests/${encodeURIComponent(id)}`,
    );

    const items = r.items || [];

    const itemRows =
      items
        .map(
          (e) => `
            <tr>
              <td class="mono">${esc(e.voucher_no)}</td>
              <td>${fmtDate(e.date)}</td>
              <td>${esc(e.details || "—")}</td>
              <td>${esc(e.projectCode || "—")}</td>
              <td>${esc(e.locationName || "—")}</td>
              <td class="num">${money(e.amount)}</td>
            </tr>
          `,
        )
        .join("") ||
      `
        <tr>
          <td colspan="6">
            <div class="empty">No vouchers in this request.</div>
          </td>
        </tr>
      `;

    Modal.open(`
      <div class="modal-head">
        <h3>${esc(r.request_no)}</h3>
        ${pill(r.status)}
        <button class="x" onclick="Modal.close()">×</button>
      </div>

      <div class="modal-body">
        <div class="detail-grid">
          ${dl("Request", esc(r.request_no ||  r.requestNo || "—"))}
          ${dl("Created", fmtDT(Number(r.created_at)))}
          ${dl("Created By", esc(r.created_by_name || "—"))}
          ${dl("Vouchers", String(items.length))}
          ${dl("Total", `<b class="mono">${money(r.total)}</b>`)}
          ${dl("Status", pill(r.status))}
        </div>

        <div class="section-t">Vouchers</div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Voucher</th>
                <th>Date</th>
                <th>Details</th>
                <th>Project</th>
                <th>Site</th>
                <th class="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              ${itemRows}
            </tbody>
          </table>
        </div>

        <div
          style="
            display:flex;
            justify-content:flex-end;
            gap:8px;
            margin-top:18px;
          "
        >
          <button
            class="btn btn-ghost"
            onclick="Views._printFundRequest('${esc(r.id)}')"
          >
            Print Request
          </button>

          <button
            class="btn btn-primary"
            onclick="Views._markFundRequestPrinted('${esc(r.id)}')"
          >
            Mark as Printed
          </button>

          <button
            class="btn btn-ghost"
            onclick="Modal.close()"
          >
            Close
          </button>
        </div>
      </div>
    `);
  } catch (e) {
    toast(e.message, "err");
  }
};

Views._printFundRequest = async function (id) {
  try {
    const r = await api(
      "GET",
      `/fund-requests/${encodeURIComponent(id)}`,
    );

    const requestNo = r.request_no || "—";
    const createdBy = r.created_by_name || "—";
    const items = r.items || [];

    const requestDate = new Date(r.created_at);
    const documentSerial =
      `YG/DhartiSiteExp/` +
      `${requestDate.toLocaleDateString("en-GB", {
        month: "short",
        year: "2-digit",
      })}/` +
      `${requestNo}`;
    

    if (!items.length) {
      toast("Fund request contains no vouchers", "err");
      return;
    }

    /* =========================================================
       REVIEWER NAMES
    ========================================================= */

    const accountsReviewers = new Set();
    const purchaseReviewers = new Set();
    const operationsReviewers = new Set();

    items.forEach((e) => {
      const names = e.approvalNames || {};

      if (names.accounts) {
        accountsReviewers.add(names.accounts);
      }

      if (names.purchase) {
        purchaseReviewers.add(names.purchase);
      }

      if (names.operations) {
        operationsReviewers.add(names.operations);
      }
    });

    const accountsReviewerName =
      Array.from(accountsReviewers).join(", ") || "—";

    const purchaseReviewerName =
      Array.from(purchaseReviewers).join(", ") || "—";

    const operationsReviewerName =
      Array.from(operationsReviewers).join(", ") || "—";

    /*
     * The Admin is the person who created the fund request.
     */
    const adminName = createdBy || "—";


    /* =========================================================
       GROUP VOUCHERS BY PROJECT
    ========================================================= */

    const projectMap = new Map();

    items.forEach((e) => {
      const key = e.projectCode || e.project_id || "UNKNOWN";

      if (!projectMap.has(key)) {
        projectMap.set(key, {
          code: e.projectCode || "UNKNOWN",
          name: e.projectName || "",
          amount: 0,
          items: [],
        });
      }

      const project = projectMap.get(key);

      project.amount += Number(e.amount || 0);
      project.items.push(e);
    });

    const projects = Array.from(projectMap.values()).sort(
      (a, b) => a.code.localeCompare(b.code),
    );

    const total = items.reduce(
      (sum, e) => sum + Number(e.amount || 0),
      0,
    );


    const projectNames = projects
      .map((p) => p.name)
      .filter(Boolean)
      .join(", ");

    const voucherDates = items
      .map((e) => e.date)
      .filter(Boolean)
      .sort();

    const oldestVoucherDate = voucherDates[0];
    const newestVoucherDate = voucherDates[voucherDates.length - 1];

    const subjectText =
      `Petty Cash Expenses for ${projectNames || "Site Expenses"} ` +
      `from ${fmtDate(oldestVoucherDate)} - ${fmtDate(newestVoucherDate)}`;

    /* =========================================================
       PAGE 1 — PROJECT SUMMARY
    ========================================================= */

    const projectRows = projects
      .map(
        (p, index) => `
          <tr>
            <td class="center">
              ${index + 1}
            </td>

            <td>
              <strong class="project-name-large">
                ${esc(p.name || "—")}
              </strong>

              <div class="project-code-small">
                ${esc(p.code || "—")}
              </div>
            </td>

            <td class="amount">
              ${money(p.amount)}
            </td>
          </tr>
        `,
      )
      .join("");


    /* =========================================================
       WORKFLOW HISTORY
    ========================================================= */

    /*
     * Reviewer names are taken from each voucher's approvalNames.
     * The detailed voucher history remains available in the API
     * response but is not printed separately here.
     */


    /* =========================================================
       ANNEXURES — ONE SECTION PER PROJECT
    ========================================================= */

    const annexures = projects
      .map((p) => {
        const voucherRows = p.items
          .map(
            (e, index) => `
              <tr>
                <td class="num">${index + 1}</td>

                <td class="mono">
                  ${esc(e.voucher_no || "—")}
                </td>

                <td>
                  ${fmtDate(e.date)}
                </td>

                <td>
                  ${esc(e.createdByName || "—")}
                </td>

                <td>
                  ${esc(e.locationName || "—")}
                </td>

                <td>
                  ${esc(e.categoryName || "—")}
                </td>

                <td>
                  ${esc(e.details || "—")}
                </td>

                <td>
                  ${["yes", "true", "1"].includes(String(e.bill_received || "").toLowerCase()) ? "Yes" : "No"}
                </td>

                <td class="num">
                  <strong>${money(e.amount)}</strong>
                </td>
              </tr>
            `,
          )
          .join("");

        return `
          <section class="annexure">
            <div class="annexure-document-header">

            <div class="annexure-logo">
                <img src="/logo.png" alt="Dharti">
              </div>

              <div class="annexure-document-title">
                APPROVAL NOTE
              </div>

              <div class="annexure-document-serial">
                Sr. No.: ${esc(documentSerial)}
              </div>
            </div>

            <div class="annexure-heading">

              <div class="annexure-title">
                ANNEXURE
              </div>

              <div class="annexure-project">
                PROJECT: ${esc(p.name || "—")}
              </div>

              <div class="annexure-project-name">
                Code: ${esc(p.code || "—")}
              </div>

            </div>

            <table class="annexure-table">

              <thead>
                <tr>
                  <th>Sr.</th>
                  <th>Voucher No.</th>
                  <th>Date</th>
                  <th>Created By</th>
                  <th>Site / Location</th>
                  <th>Category</th>
                  <th>Details</th>
                  <th>Bill</th>
                  <th class="num">Amount</th>
                </tr>
              </thead>

              <tbody>
                ${voucherRows}
              </tbody>

              <tfoot>
                <tr>
                  <td colspan="8" class="num">
                    <strong>Project Total</strong>
                  </td>

                  <td class="num">
                    <strong>${money(p.amount)}</strong>
                  </td>
                </tr>
              </tfoot>

            </table>

          </section>
        `;
      })
      .join("");


    /* =========================================================
       PRINT WINDOW
    ========================================================= */

    const w = window.open(
      "SiteXpense",
      "_blank",
      "width=1100,height=800",
    );

    if (!w) {
      toast("Please allow pop-ups to print", "err");
      return;
    }

    w.document.write(`
      <!DOCTYPE html>

      <html>

      <head>
        <title> ${esc(requestNo)}</title>
        <style>

          @page {
            size: A4 portrait;
            margin: 12mm;
          }

          * {
            box-sizing: border-box;
          }

          body {
            margin: 0;
            padding: 0;
            font-family:
              Arial,
              Helvetica,
              sans-serif;

            color: #111;

            font-size: 11px;

            line-height: 1.35;
          }
          /* =================================================
             HEADER
          ================================================= */

          .document-header {
            position: relative;
            min-height: 82px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 12px;
          }

          .document-header-logo {
            position: absolute;
            left: 50%;
            top: 0;
            transform: translateX(-50%);
            width: 90px;
            height: 55px;
            display: flex;
            align-items: center;
            justify-content: center;
          }

          .document-header-logo img {
            max-width: 85px;
            max-height: 55px;
            object-fit: contain;
          }

          .document-header-title {
            position: relative;
            width: 100%;
            text-align: center;
            padding-top: 52px;
          }

          .document-header-serial {
            position: absolute;
            left: 0;
            top: 10px;
            width: 100%;
            text-align: left;
          }

          .serial-label {
            font-size: 9px;
            font-weight: bold;
            text-transform: uppercase;
          }

          .serial-value {
            font-size: 10px;
            font-weight: bold;
            margin-top: 2px;
          }

          /* =================================================
             PAGE
          ================================================= */

          .page {
            min-height: 270mm;
            position: relative;
          }
          .project-name-large {
            display: block;
            font-size: 12px;
            font-weight: 700;
          }

          .project-code-small {
            display: block;
            margin-top: 2px;
            font-size: 9px;
            color: #555;
          }

          /* =================================================
             PAGE 1 HEADER
          ================================================= */

          .document-title {
            text-align: center;

            font-size: 20px;

            font-weight: bold;

            margin-bottom: 3px;

            text-transform: uppercase;
          }

          .document-subtitle {
            text-align: center;

            font-size: 11px;

            margin-bottom: 18px;
          }


          /* =================================================
             META
          ================================================= */

          .meta-table {
            width: 100%;

            border-collapse: collapse;

            margin-bottom: 18px;
          }

          .meta-table td {
            border: 1px solid #999;

            padding: 7px 9px;
          }

          .meta-label {
            font-weight: bold;

            width: 100px;
          }


          /* =================================================
             TO / SUBJECT
          ================================================= */

          .to-block {
            border: 1px solid #999;

            padding: 8px 10px;

            margin-top: 10px;

            margin-bottom: 9px;

            font-size: 12px;
          }

          .from-block {
            border: 1px solid #999;

            padding: 8px 10px;

            margin-top: 10px;

            margin-bottom: 9px;

            font-size: 12px;
          }

          .subject {
            border: 1px solid #999;

            padding: 8px 10px;

            margin-bottom: 18px;

            font-size: 12px;
          }

          .subject-label {
            font-weight: bold;

            margin-right: 8px;
          }


          /* =================================================
             SECTION
          ================================================= */

          .section-heading {
            font-size: 14px;

            font-weight: bold;

            text-decoration: underline;

            margin-bottom: 8px;
          }


          /* =================================================
             GENERAL TABLE
          ================================================= */

          table {
            width: 100%;

            border-collapse: collapse;
          }

          th,
          td {
            border: 1px solid #888;

            padding: 6px 7px;

            vertical-align: top;
          }

          th {
            text-align: center;

            font-weight: bold;
          }

          .center {
            text-align: center;
          }

          .amount {
            text-align: right;

            white-space: nowrap;
          }

          .muted {
            color: #555;

            font-size: 9px;
          }


          /* =================================================
             TOTAL
          ================================================= */

          .summary-total {
            margin-top: 12px;

            display: flex;

            justify-content: flex-end;
          }

          .summary-total-box {
            border: 1px solid #777;

            padding: 9px 12px;

            min-width: 260px;

            display: flex;

            justify-content: space-between;

            gap: 30px;

            font-size: 13px;

            font-weight: bold;
          }


          /* =================================================
             NOTE
          ================================================= */

          .request-note {
            margin-top: 22px;

            margin-bottom: 10px;

            border: 1px solid #999;

            padding: 10px 12px;

            font-size: 10px;
          }


          /* =================================================
             SIGNATURES
          ================================================= */

          .signature-area {
            position: static;
            margin-top: 34px;
            margin-bottom: 58px;
          }

          .digital-verification-title {
            text-align: left;

            font-size: 11px;

            font-weight: bold;

            margin-bottom: 7px;
          }

          .digital-signatures {
            display: grid;

            grid-template-columns: 1fr 1fr;

            gap: 7px 12px;

            margin-bottom: 14px;
          }

          .digital-signature-box {
            border: 1px solid #555;

            min-height: 48px;

            padding: 6px 8px;

            text-align: center;

            page-break-inside: avoid;
          }

          .digital-signature-status {
            font-size: 8px;

            font-weight: bold;

            letter-spacing: 0.5px;

            margin-bottom: 5px;
          }

          .digital-signature-name {
            font-weight: bold;

            font-size: 10px;
          }

          .digital-signature-role {
            font-size: 8px;

            margin-top: 2px;
          }

          .physical-signatures {
            display: grid;

            grid-template-columns: 1fr 1fr;

            gap: 100px;
          }

          .signature-box {
            text-align: center;

            padding-top: 45px;
          }

          .signature-line {
            border-top: 1px solid #111;

            margin-top: 60px;

            margin-bottom: 10px;
          }

          .signature-name {
            font-weight: bold;
            margin-top: 10px;

            font-size: 11px;
          }
            
          .approval-header {
            position: relative;
            width: 100%;
          }

          .sr-number {
              position: absolute;
              right: 0;
              top: 50%;
              transform: translateY(-50%);
              font-size: 9px;
              font-weight: bold;
              white-space: nowrap;
          }

          /* =================================================
             ANNEXURE
          ================================================= */

          .annexure-table {
            width: 100%;

            border-collapse: collapse;

            font-size: 9px;
          }

          .annexure-table th,
          .annexure-table td {
            border: 1px solid #333;

            padding: 4px 5px;

            vertical-align: top;
          }

          .annexure-table th {
            text-align: center;

            font-weight: 700;
          }

          .annexure-table .num {
            text-align: right;

            white-space: nowrap;
          }

          .annexure-table thead {
            display: table-header-group;
          }

          .annexure-table tfoot {
            display: table-row-group;
          }

          .annexure-table tr {
            page-break-inside: avoid;
          }

          .annexure {
            page-break-before: always;
          }

          .annexure-title {
            font-weight: 700;
          }

          .annexure-project {
            font-weight: 700;

            margin-top: 3px;
          }

          .annexure-project-name {
            margin-bottom: 8px;
          }

          .annexure {
            page-break-before: always;
          }

          .annexure-heading {
            text-align: center;

            margin-bottom: 18px;
          }
          .annexure-document-header {
            position: relative;
            min-height: 62px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 10px;
            border-bottom: 1px solid #aaa;
            padding-bottom: 7px;
          }

          .annexure-logo {
            position: absolute;
            left: 0;
            top: 0;
          }

          .annexure-logo img {
            width: 58px;
            height: 42px;
            object-fit: contain;
          }

          .annexure-document-title {
            text-align: center;
            font-size: 14px;
            font-weight: bold;
          }

          .annexure-document-title div {
            font-size: 8px;
            font-weight: normal;
            margin-top: 2px;
          }

          .annexure-document-serial {
            position: absolute;
            right: 0;
            top: 25px;
            font-size: 8px;
            font-weight: bold;
          }

          .annexure-title {
            font-size: 17px;

            font-weight: bold;

            text-decoration: underline;
          }

          .annexure-project {
            font-size: 15px;

            font-weight: bold;

            margin-top: 5px;
          }

          .annexure-project-name {
            font-size: 10px;

            color: #555;

            margin-top: 2px;
          }


          /* =================================================
             VOUCHER BLOCK
          ================================================= */

          .voucher-block {
            margin-bottom: 22px;

            page-break-inside: avoid;
          }

          .voucher-heading {
            display: flex;

            justify-content: space-between;

            align-items: center;

            border: 1px solid #777;

            border-bottom: 0;

            padding: 7px 9px;

            font-size: 12px;

            background: #f5f5f5;
          }

          .voucher-no {
            margin-left: 12px;

            font-weight: bold;
          }

          .voucher-amount {
            font-weight: bold;

            white-space: nowrap;
          }


          /* =================================================
             VOUCHER DETAILS
          ================================================= */

          .voucher-details {
            margin-bottom: 8px;
          }

          .voucher-details .label {
            width: 110px;

            font-weight: bold;

            background: #fafafa;
          }


          /* =================================================
             PROJECT TOTAL
          ================================================= */

          .project-total {
            display: flex;

            justify-content: flex-end;

            gap: 30px;

            font-size: 12px;

            font-weight: bold;

            margin-top: 5px;

            padding: 8px;

            border-top: 2px solid #555;
          }


          /* =================================================
             PRINT
          ================================================= */

          tr {
            page-break-inside: avoid;
          }

          @media print {

            body {
              margin: 0;
            }

          }

        </style>

      </head>


      <body>


        <!-- =================================================
             PAGE 1
        ================================================= -->

        <section class="page">


          <div class="document-header">
            <div class="document-header-logo">
              <img src="/logo.png" alt="Dharti">
            </div>

            <div class="document-header-title">
              <div class="approval-header">
                <div class="document-title">
                  APPROVAL NOTE
                </div>
                <div class="sr-number">
                  SR. NO. ${esc(documentSerial)}
                </div>
              </div>              
            </div>

            
          </div>


          <table class="meta-table">

            <tr>

              <td class="meta-label">
                Request No.
              </td>

              <td>
                ${esc(requestNo || "—")}
              </td>

              <td class="meta-label">
                Date
              </td>

              <td>
                ${fmtDate(r.created_at)}
              </td>

            </tr>

          </table>


          <div class="to-block">
            <div>
              <strong>To:</strong>
                Hon. Chairman Sir, Managing Director Sir
            </div>
          </div>
          <div class="from-block">
            <div>
              <strong>From:</strong>
              Purchase Dept.
            </div>
          </div>

          <div class="subject">
            <span class="subject-label">
              Subject:
            </span>

            ${esc(subjectText)}
          </div>


          <div class="section-heading">
            Project-wise Fund Requirement
          </div>


          <table>

            <thead>

              <tr>

                <th style="width:55px">
                  Sr. No.
                </th>

                <th>
                  Project
                </th>

                <th style="width:170px">
                  Requested Amount (Rs.)
                </th>

              </tr>

            </thead>

            <tbody>
              ${projectRows}
            </tbody>

          </table>


          <div class="summary-total">

            <div class="summary-total-box">

              <span>
                Total Request Amount
              </span>

              <span>
                ${money(total)}
              </span>

            </div>

          </div>
          <div class="amount-in-words">
            <strong>Amount in Words:</strong>
            ${esc(amountInWordsIndian(total))}
          </div>


          <div class="request-note">

            <strong>Purpose:</strong>

            This request is submitted for release of funds
            against approved Site Expense vouchers listed
            in the annexures attached with this request.

          </div>

          <div class="payment-details">
            <div>
              <strong>Payment To:</strong>
              Vipul Save
            </div>

            <div>
              <strong>Paid From:</strong>
              Dharti Dredging and Infrastructure Ltd.
            </div>

            <div>
              <strong>Mode:</strong>
              NEFT / RTGS
            </div>
          </div>

          <!-- =================================================
              DIGITAL VERIFICATION
          ================================================= -->

          <div class="signature-area">

            <div class="digital-verification-title">
              DIGITAL VERIFICATION
            </div>

            <div class="digital-signatures">

              <!-- PURCHASE -->
              <div class="digital-signature-box">
                <div class="digital-signature-status">
                  DIGITALLY VERIFIED
                </div>

                <div class="digital-signature-name">
                  ${esc(purchaseReviewerName || "—")}
                </div>

                <div class="digital-signature-role">
                  Purchase Reviewer
                </div>
              </div>


              <!-- OPERATIONS -->
              <div class="digital-signature-box">
                <div class="digital-signature-status">
                  DIGITALLY VERIFIED
                </div>

                <div class="digital-signature-name">
                  ${esc(operationsReviewerName || "—")}
                </div>

                <div class="digital-signature-role">
                  Operations Reviewer
                </div>
              </div>


              <!-- ACCOUNTS -->
              <div class="digital-signature-box">
                <div class="digital-signature-status">
                  DIGITALLY VERIFIED
                </div>

                <div class="digital-signature-name">
                  ${esc(accountsReviewerName || "—")}
                </div>

                <div class="digital-signature-role">
                  Accounts Manager
                </div>
              </div>


              <!-- ADMIN -->
              <div class="digital-signature-box">
                <div class="digital-signature-status">
                  DIGITALLY VERIFIED
                </div>

                <div class="digital-signature-name">
                  ${esc(adminName || "—")}
                </div>

                <div class="digital-signature-role">
                  Admin
                </div>
              </div>

            </div>

          </div>
            <!-- =================================================
                 PHYSICAL SIGNATURES
            ================================================= -->

            <div class="physical-signatures">

              <div class="signature-box">

                <div class="signature-line"></div>

                <div class="signature-name">
                  Managing Director Sir
                </div>

              </div>


              <div class="signature-box">

                <div class="signature-line"></div>

                <div class="signature-name">
                  Hon. Chairman Sir
                </div>

              </div>

            </div>

          </div>


        </section>


        <!-- =================================================
             PAGE 2 ONWARD
             PROJECT-WISE ANNEXURES
        ================================================== -->

        ${annexures}


        <script>

          window.onload = function () {
            window.print();
          };

        </script>


      </body>

      </html>
    `);

    w.document.close();

    Modal.close();

  } catch (e) {
    toast(e.message, "err");
  }
};


Views._markFundRequestPrinted = async function (id) {
  try {
    if (
      !confirm(
        "Mark this fund request as Printed?\n\n" +
        "Confirm that the paperwork has been physically printed."
      )
    ) {
      return;
    }

    const result = await api(
      "POST",
      `/fund-requests/${encodeURIComponent(id)}/print`,
    );

    Modal.close();

    toast(
      `Fund request marked as ${result.status || "Printed"}`,
      "ok"
    );

    go("fundRequestsPurchase");
  } catch (e) {
    toast(e.message, "err");
  }
};


Views._printSelectedFundRequests = async function () {
  const ids = $$(".frp-cb")
    .filter((cb) => cb.checked)
    .map((cb) => cb.value);

  if (!ids.length) {
    toast("Select at least one fund request", "err");
    return;
  }

  if (ids.length === 1) {
    Views._printFundRequest(ids[0]);
    return;
  }

  if (
    !confirm(
      `Print ${ids.length} fund requests? Each request will be printed separately.`,
    )
  ) {
    return;
  }

  for (const id of ids) {
    await Views._printFundRequest(id);
  }
};

Views.paymentReceived = async function () {
  const ex = await api("GET", "/expenses");

  const list = ex.filter(
    (e) => e.status === "Payment Approved"
  );

  const total = list.reduce(
    (s, e) => s + (+e.amount || 0),
    0
  );

  const rows =
    list
      .map(
        (e) => `
        <tr>
          <td>
            <input
              type="checkbox"
              class="pr-cb"
              value="${e.id}"
            >
          </td>

          <td class="mono">
            ${esc(e.voucher_no)}
          </td>

          <td>
            ${fmtDate(e.date)}
          </td>

          <td>
            ${esc((e.details || "").slice(0, 40))}
          </td>

          <td>
            ${esc(e.projectCode)}
          </td>

          <td class="num">
            ${money(e.amount)}
          </td>

          <td>
            ${pill(e.status)}
          </td>

          <td>
            <button
              class="btn btn-ghost btn-sm"
              onclick="Detail.open('${e.id}')"
            >
              View
            </button>
          </td>
        </tr>
      `,
      )
      .join("") ||
    `
      <tr>
        <td colspan="8">
          <div class="empty">
            No payments awaiting receipt confirmation.
          </div>
        </td>
      </tr>
    `;

  $("#content").innerHTML = `
    <div class="card">

      <div
        class="card-pad"
        style="
          display:flex;
          align-items:center;
          justify-content:space-between;
          border-bottom:1px solid var(--line);
        "
      >

        <div>
          <h3>Payment Received</h3>

          <div class="csub" style="margin:0">
            ${list.length}
            voucher(s) awaiting receipt confirmation
            ·
            ${money(total)}
          </div>
        </div>

        <div style="display:flex;gap:8px">

          <button
            class="btn btn-ghost"
            onclick="Views._printPaymentReceived()"
          >
            Print Selected
          </button>

          <button
            class="btn btn-primary"
            onclick="Views._confirmPaymentReceived()"
          >
            Mark Payment Received
          </button>

        </div>

      </div>

      <div class="table-wrap">
        <table>

          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  onclick="Views._toggleAllPaymentReceived(this)"
                >
              </th>

              <th>Voucher</th>
              <th>Date</th>
              <th>Details</th>
              <th>Project</th>
              <th class="num">Amount</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>

          <tbody>
            ${rows}
          </tbody>

        </table>
      </div>

    </div>
  `;
};

Views._toggleAllPaymentReceived = function (master) {
  $$(".pr-cb").forEach((cb) => {
    cb.checked = master.checked;
  });
};

Views._confirmPaymentReceived = async function () {
  const ids = $$(".pr-cb")
    .filter((cb) => cb.checked)
    .map((cb) => cb.value);

  if (!ids.length) {
    toast("Select at least one voucher", "err");
    return;
  }

  if (
    !confirm(
      `Confirm that payment has been received for ${ids.length} voucher(s)?`
    )
  ) {
    return;
  }

  try {
    const r = await api(
      "POST",
      "/payments/received",
      { ids }
    );

    toast(
      `${r.received} payment(s) marked as Paid`,
      "ok"
    );

    go("paymentReceived");
  } catch (e) {
    toast(e.message, "err");
  }
};
Views._printPaymentReceived = async function () {
  const ids = $$(".pr-cb")
    .filter((cb) => cb.checked)
    .map((cb) => cb.value);

  if (!ids.length) {
    toast("Select at least one voucher", "err");
    return;
  }

  const ex = await api("GET", "/expenses");

  const selected = ex.filter(
    (e) =>
      ids.includes(e.id) &&
      e.status === "Payment Approved"
  );

  if (!selected.length) {
    toast(
      "No selected Payment Approved vouchers found",
      "err"
    );
    return;
  }

  const total = selected.reduce(
    (s, e) => s + (+e.amount || 0),
    0
  );

  const rows = selected
    .map(
      (e) => `
        <tr>
          <td>${esc(e.voucher_no)}</td>
          <td>${fmtDate(e.date)}</td>
          <td>${esc(e.details || "")}</td>
          <td>${esc(e.projectCode || "")}</td>
          <td style="text-align:right">
            ${money(e.amount)}
          </td>
          <td>Payment Approved</td>
        </tr>
      `
    )
    .join("");

  const w = window.open(
    "",
    "_blank",
    "width=1100,height=800"
  );

  if (!w) {
    toast(
      "Please allow pop-ups to print",
      "err"
    );
    return;
  }

  w.document.write(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Payment Approved</title>

        <style>
          body {
            font-family: Arial, sans-serif;
            margin: 35px;
            color: #111;
          }

          h1 {
            margin-bottom: 5px;
          }

          .sub {
            color: #666;
            margin-bottom: 25px;
          }

          table {
            width: 100%;
            border-collapse: collapse;
          }

          th,
          td {
            border: 1px solid #ccc;
            padding: 9px;
            text-align: left;
          }

          th {
            background: #f3f3f3;
          }

          .total {
            margin-top: 20px;
            text-align: right;
            font-size: 18px;
            font-weight: bold;
          }

          .notice {
            margin-top: 25px;
            padding: 12px;
            border: 1px solid #ccc;
            background: #fafafa;
          }

          @media print {
            body {
              margin: 15mm;
            }
          }
        </style>
      </head>

      <body>

        <h1>Payment Approved</h1>

        <div class="sub">
          Vouchers awaiting Admin confirmation of payment received
        </div>

        <table>
          <thead>
            <tr>
              <th>Voucher</th>
              <th>Date</th>
              <th>Details</th>
              <th>Project</th>
              <th>Amount</th>
              <th>Status</th>
            </tr>
          </thead>

          <tbody>
            ${rows}
          </tbody>
        </table>

        <div class="total">
          Total: ${money(total)}
        </div>

        <div class="notice">
          <strong>Payment Status:</strong>
          Payment Approved
          <br><br>
          This document is printed before Admin confirms
          that the payment has been received.
        </div>

        <script>
          window.onload = function () {
            window.print();
          };
        </script>

      </body>
    </html>
  `);

  w.document.close();
};

Views._downloadPayment = function (id) {
  const a = document.createElement("a");
  a.href = `/api/payments/${encodeURIComponent(id)}/download`;
  a.click();
};

Views._downloadSelectedPayments = async function () {
  const ids = $$(".pay-cb")
    .filter((cb) => cb.checked)
    .map((cb) => cb.value);

  if (!ids.length) {
    toast("Select at least one voucher", "err");
    return;
  }

  try {
    const r = await fetch("/api/payments/download", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids }),
    });

    if (r.status === 401) {
      showLogin();
      throw new Error("Session expired");
    }

    if (!r.ok) {
      const ct = r.headers.get("content-type") || "";
      const data = ct.includes("json") ? await r.json() : await r.text();
      throw new Error((data && data.error) || `HTTP ${r.status}`);
    }

    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");

    a.href = url;
    a.download = `siteexpense-selected-payments-${Date.now()}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    URL.revokeObjectURL(url);
  } catch (e) {
    toast(e.message, "err");
  }
};

Views._downloadSelectedVouchers = async function () {
  const ids = $$(".dv-cb")
    .filter((cb) => cb.checked)
    .map((cb) => cb.value);

  if (!ids.length) {
    toast("Select at least one voucher", "err");
    return;
  }

  try {
    const r = await fetch("/api/vouchers/download", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });

    if (r.status === 401) {
      showLogin();
      throw new Error("Session expired");
    }

    if (!r.ok) {
      const ct = r.headers.get("content-type") || "";
      const data = ct.includes("json") ? await r.json() : await r.text();
      throw new Error((data && data.error) || `HTTP ${r.status}`);
    }

    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `siteexpense-vouchers-${Date.now()}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    toast(e.message, "err");
  }
};

Views._toggleAllPay = function (master) {
  $$(".pay-cb").forEach((cb) => {
    cb.checked = master.checked;
  });
};
Views._confirmPay = async function () {
  const ids = $$(".pay-cb")
    .filter((cb) => cb.checked)
    .map((cb) => cb.value);
  if (!ids.length) {
    toast("Select at least one voucher", "err");
    return;
  }
  if (
    !confirm(
      `Confirm payment for ${ids.length} voucher(s)? They will move out of this list.`,
    )
  )
    return;
  try {
    const r = await api("POST", "/payments", { ids });
    toast(
      `${r.paid} payment(s) confirmed · ${money(r.released)} released`,
      "ok"
    );
    go("payments");
  } catch (e) {
    toast(e.message, "err");
  }
};

Views.expenses = async function () {
  const cats = S.categories,
    prj = S.projects;
  $("#content").innerHTML = `
    <div class="toolbar card card-pad" style="padding:12px 14px">
      <input id="fx-q" placeholder="Search details / voucher…" oninput="Views._filterExp()">
      <select id="fx-status" onchange="Views._filterExp()"><option value="">All statuses</option>${Object.keys(
        PILL,
      )
        .map((s) => `<option>${s}</option>`)
        .join("")}</select>
      <select id="fx-cat" onchange="Views._filterExp()"><option value="">All categories</option>${cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
      <select id="fx-prj" onchange="Views._filterExp()"><option value="">All projects</option>${prj.map((p) => `<option value="${p.id}">${esc(p.code)} · ${esc(p.name)}</option>`).join("")}</select>
      <div class="spacer"></div><span id="fx-count" class="csub" style="margin:0"></span>
    </div>
    <div class="card" id="fx-table"></div>`;
  if (can.create())
    $("#topActions").innerHTML =
      `<button class="btn btn-primary" onclick="ExpenseForm.open()">+ New Expense</button>`;
  Views._allExp = await api("GET", "/expenses");
  Views._filterExp();
};
Views._filterExp = function () {
  let rows = Views._allExp || [];
  const q = ($("#fx-q").value || "").toLowerCase(),
    st = $("#fx-status").value,
    c = $("#fx-cat").value,
    p = $("#fx-prj").value;
  if (q)
    rows = rows.filter(
      (e) =>
        (e.details || "").toLowerCase().includes(q) ||
        e.voucher_no.toLowerCase().includes(q),
    );
  if (st) rows = rows.filter((e) => e.status === st);
  if (c) rows = rows.filter((e) => e.category_id === c);
  if (p) rows = rows.filter((e) => e.project_id === p);
  $("#fx-table").innerHTML = expenseTable(rows);
  $("#fx-count").textContent =
    `${rows.length} vouchers · ${money(rows.reduce((s, e) => s + (+e.amount || 0), 0))}`;
};

Views.review = async function () {
  const rows = pendingForMe(await api("GET", "/expenses"));
  const hint =
    {
      checker: "Submitted items awaiting your check.",
      purchase: "Checked items awaiting purchase review.",
      operations: "Purchase-reviewed items awaiting operations review.",
      accounts: "Items awaiting accounts review / approval.",
      account_checker: "Items awaiting Level 4 accounts review.",
      admin: "All items in the review pipeline.",
    }[S.user.role] || "";
  $("#content").innerHTML =
      `<div class="card card-pad" style="margin-bottom:16px;display:flex;align-items:center"><div class="csub" style="margin:0">${esc(hint)}</div><span class="tag" style="margin-left:auto">${rows.length} pending</span></div><div class="card">${expenseTable(rows, { reviewActions: S.user.role === "accounts" })}</div>`;
};

Views.funds = async function () {
  const d = await api("GET", "/funds");
  const t = d.totals;
  if (d.role === "checker") {
    const balRows =
      d.balances
        .map(
          (b) =>
            `<tr><td><b>${esc(b.code)}</b> · ${esc(b.name)}</td><td class="num mono">${money(b.given)}</td><td class="num mono">${money(b.distributed)}</td><td class="num mono ${b.available >= 0 ? "bal-pos" : "bal-neg"}">${money(b.available)}</td></tr>`,
        )
        .join("") ||
      '<tr><td colspan="4"><div class="empty">No projects in your access</div></td></tr>';
    const siteRows =
      (d.siteAllocations || [])
        .map(
          (s) =>
            `<tr><td>${esc(s.userName)}</td><td class="num mono">${money(s.allocated)}</td><td class="num mono">${money(s.spent)}</td><td class="num mono ${s.balance >= 0 ? "bal-pos" : "bal-neg"}">${money(s.balance)}</td></tr>`,
        )
        .join("") ||
      '<tr><td colspan="4"><div class="empty">No allocations yet</div></td></tr>';
    const fundList =
      d.funds
        .map(
          (f) =>
            `<tr><td>${fmtDate(f.date)}</td><td>${esc(f.projectCode || "—")}</td><td>${f.kind === "allocation" ? "→ " + esc(f.toUserName || "site") : "Received from Accounts"}</td><td class="num"><span class="tag" style="background:${f.kind === "allocation" ? "var(--line)" : "var(--green-soft)"};color:${f.kind === "allocation" ? "var(--ink)" : "var(--green)"}">${f.kind === "allocation" ? "− " : "+ "}${money(f.amount)}</span></td><td>${esc(f.note || "—")}</td></tr>`,
        )
        .join("") ||
      '<tr><td colspan="5"><div class="empty">No fund movements yet</div></td></tr>';
    $("#content").innerHTML = `
      <div class="grid stat-row" style="margin-bottom:18px">
        <div class="stat green"><div class="lab">Received</div><div class="val">${money(t.received)}</div><div class="sub2">from accounts</div></div>
        <div class="stat accent"><div class="lab">Distributed</div><div class="val">${money(t.distributed)}</div><div class="sub2">to sites</div></div>
        <div class="stat blue"><div class="lab">Balance In Hand</div><div class="val" style="color:${t.balance >= 0 ? "var(--green)" : "var(--red)"}">${money(t.balance)}</div><div class="sub2">${money(t.spent)} own spend</div></div>
        <div className="stat-card">
            <div className="stat-label">ADMIN WALLET</div>
            <div className="stat-value">
              {money(data.adminFund?.available || 0)}
            </div>
            <div className="stat-sub">Available to release to projects</div>
          </div>
        </div>
      <div class="card" style="margin-bottom:18px"><div class="card-pad" style="display:flex;align-items:center;border-bottom:1px solid var(--line)"><div><h3>By Project</h3><div class="csub" style="margin:0">Received − Distributed = available to distribute</div></div><button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="FundsAdmin.allocate()">+ Allocate to Site</button></div><div class="table-wrap"><table><thead><tr><th>Project</th><th class="num">Received</th><th class="num">Distributed</th><th class="num">Available</th></tr></thead><tbody>${balRows}</tbody></table></div></div>
      <div class="card" style="margin-bottom:18px"><div class="card-pad" style="border-bottom:1px solid var(--line)"><h3>Site Allocations</h3></div><div class="table-wrap"><table><thead><tr><th>Site</th><th class="num">Allocated</th><th class="num">Spent</th><th class="num">Balance</th></tr></thead><tbody>${siteRows}</tbody></table></div></div>
      <div class="card"><div class="card-pad" style="border-bottom:1px solid var(--line)"><h3>Fund Movements</h3></div><div class="table-wrap"><table><thead><tr><th>Date</th><th>Project</th><th>Type</th><th class="num">Amount</th><th>Note</th></tr></thead><tbody>${fundList}</tbody></table></div></div>`;
    return;
  }
  // accounts / admin — project pool view
  const balRows =
    d.balances
      .filter((b) => b.code !== "ADMIN-FUND")
      .map(
        (b) =>
          `<tr><td><b>${esc(b.code)}</b> · ${esc(b.name)}</td><td class="num mono">${money(b.given)}</td><td class="num mono">${money(b.spent)}</td><td class="num mono ${b.balance >= 0 ? "bal-pos" : "bal-neg"}">${money(b.balance)}</td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="4"><div class="empty">No projects in your access</div></td></tr>';
  const fundList =
    d.funds
      .map(
        (f) =>
          `<tr><td>${fmtDate(f.date)}</td><td>${esc(f.projectCode || "—")}</td><td>${f.kind === "allocation" ? "→ " + esc(f.toUserName || "site") : "Released"}</td><td class="num"><span class="tag" style="background:var(--green-soft);color:var(--green)">+ ${money(f.amount)}</span></td><td>${esc(f.addedByName || "—")}</td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="5"><div class="empty">No funds recorded yet</div></td></tr>';
  FundsAdmin._adminFundBalance = d.adminFund ? d.adminFund.balance : 0;  
  $("#content").innerHTML = `
        <div class="grid stat-row" style="margin-bottom:18px;grid-template-columns:repeat(4,1fr)">
      <div class="stat green">
        <div class="lab">Funds Released</div>
        <div class="val">${money(t.received)}</div>
        <div class="sub2">to projects</div>
      </div>

      <div class="stat accent">
        <div class="lab">Spent</div>
        <div class="val">${money(t.spent)}</div>
        <div class="sub2">excludes rejected</div>
      </div>

      <div class="stat blue">
        <div class="lab">Balance In Hand</div>
        <div class="val" style="color:${t.balance >= 0 ? "var(--green)" : "var(--red)"}">
          ${money(t.balance)}
        </div>
      </div>

      <div class="stat green">
        <div class="lab">Admin Wallet</div>
        <div class="val" style="color:${FundsAdmin._adminFundBalance >= 0 ? "var(--green)" : "var(--red)"}">
          ${money(FundsAdmin._adminFundBalance)}
        </div>
        <div class="sub2">available to release</div>
      </div>
    </div>
    <div class="card" style="margin-bottom:18px"><div class="card-pad" style="display:flex;align-items:center;border-bottom:1px solid var(--line)"><div><h3>Balance by Project</h3><div class="csub" style="margin:0">Released − Spent</div></div>${can.addFunds() && d.role === "admin" ? `<button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="FundsAdmin.add()">+ Release Funds</button>` : ""}</div><div class="table-wrap"><table><thead><tr><th>Project</th><th class="num">Released</th><th class="num">Spent</th><th class="num">Balance</th></tr></thead><tbody>${balRows}</tbody></table></div></div>
    <div class="card"><div class="card-pad" style="border-bottom:1px solid var(--line)"><h3>Fund Movements</h3></div><div class="table-wrap"><table><thead><tr><th>Date</th><th>Project</th><th>Type</th><th class="num">Amount</th><th>By</th></tr></thead><tbody>${fundList}</tbody></table></div></div>`;
};

Views.reports = async function () {
  const cats = S.categories,
    prj = S.projects;
  $("#content").innerHTML = `<div class="card card-pad">
    <h3>Report Filters</h3><div class="csub">Filter the dataset, then download CSV</div>
    <div class="frow three" style="margin-top:6px">
      <div class="field"><label>From</label><input type="date" id="rp-from"></div>
      <div class="field"><label>To</label><input type="date" id="rp-to"></div>
      <div class="field"><label>Status</label><select id="rp-status"><option value="">All</option>${Object.keys(
        PILL,
      )
        .map((s) => `<option>${s}</option>`)
        .join(
          "",
        )}<option value="__paid">Paid</option><option value="__unpaid">Approved (unpaid)</option></select></div>
    </div>
    <div class="frow"><div class="field"><label>Project</label><select id="rp-prj"><option value="">All</option>${prj.map((p) => `<option value="${p.id}">${esc(p.code)} · ${esc(p.name)}</option>`).join("")}</select></div></div>
    <div style="margin-top:10px"><button class="btn btn-primary" onclick="Views._csv()">⤓ Download CSV</button></div>
  </div>`;
};
Views._csv = function () {
  const q = new URLSearchParams();
  ["from", "to", "status"].forEach((k) => {
    const v = $("#rp-" + k).value;
    if (v) q.set(k, v);
  });
  const p = $("#rp-prj").value;
  if (p) q.set("projectId", p);
  const a = document.createElement("a");
  a.href = "/api/reports/expenses.csv?" + q.toString();
  a.click();
};

Views.users = async function () {
  const users = await api("GET", "/users");
  Views._users = users;
  $("#content").innerHTML =
    `<div class="card"><div class="card-pad" style="display:flex;align-items:center;border-bottom:1px solid var(--line)"><div><h3>User Accounts</h3><div class="csub" style="margin:0">${users.length} users</div></div><button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="UsersAdmin.edit()">+ Create User</button></div>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Profile</th><th>Project Access</th><th>Status</th><th></th></tr></thead><tbody>${users.map((u) => `<tr><td><b>${esc(u.name)}</b></td><td class="mono">${esc(u.username)}</td><td><span class="tag">${ROLES[u.role]}</span></td><td>${u.all_projects ? '<span class="tag" style="background:var(--accent-soft);color:var(--accent-d)">All</span>' : u.project_ids.length ? u.project_ids.map((id) => `<span class="tag">${esc((S.allProjects.find((p) => p.id === id) || {}).code || "?")}</span>`).join(" ") : '<span class="tag">none</span>'}</td><td>${u.active ? '<span class="pill p-app">Active</span>' : '<span class="pill p-rej">Disabled</span>'}</td><td style="text-align:right"><button class="btn btn-ghost btn-sm" onclick="UsersAdmin.edit('${u.id}')">Edit</button>${u.id !== S.user.id ? `<button class="btn btn-ghost btn-sm" onclick="UsersAdmin.toggle('${u.id}')">${u.active ? "Disable" : "Enable"}</button>` : '<span class="tag">you</span>'}</td></tr>`).join("")}</tbody></table></div></div>`;
};

Views.accountCheckers = async function () {
  const users = await api("GET", "/account-checkers");
  Views._accountCheckers = users;
  const rows = users.map((u) => `<tr><td><b>${esc(u.name)}</b></td><td class="mono">${esc(u.username)}</td><td>${u.all_projects ? '<span class="tag">All</span>' : u.project_ids.length ? u.project_ids.map((id) => `<span class="tag">${esc((S.allProjects.find((p) => p.id === id) || {}).code || "?")}</span>`).join(" ") : '<span class="tag">none</span>'}</td><td>${u.active ? '<span class="pill p-app">Active</span>' : '<span class="pill p-rej">Disabled</span>'}</td><td style="text-align:right"><button class="btn btn-ghost btn-sm" onclick="AccountCheckerAdmin.edit('${u.id}')">Edit</button><button class="btn btn-ghost btn-sm" onclick="AccountCheckerAdmin.toggle('${u.id}')">${u.active ? "Disable" : "Enable"}</button></td></tr>`).join("");
  $("#content").innerHTML = `<div class="card"><div class="card-pad" style="display:flex;align-items:center;border-bottom:1px solid var(--line)"><div><h3>Account Checkers</h3><div class="csub" style="margin:0">${users.length} users</div></div><button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="AccountCheckerAdmin.edit()">+ Create Account Checker</button></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Project Access</th><th>Status</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="5"><div class="empty">No Account Checkers yet.</div></td></tr>'}</tbody></table></div></div>`;
};

Views.masters = async function () {
  return Views._master("categories");
};
Views._master = async function (which) {
  const d = await api("GET", "/masters"); // all rows, active + inactive
  Views._mastersData = d;
  const list = d[which] || [];
  const tabs = ["categories", "projects", "locations"];
  const head =
    which === "projects"
      ? "<th>Code</th><th>Name</th><th>Status</th><th></th>"
      : "<th>Name</th><th>Status</th><th></th>";
  const statusPill = (x) =>
    x.active
      ? '<span class="pill p-app">Active</span>'
      : '<span class="pill p-rej">Inactive</span>';
  const toggleBtn = (x) =>
    `<button class="btn btn-ghost btn-sm" onclick="Masters.toggle('${which}','${x.id}')">${x.active ? "Disable" : "Enable"}</button>`;
  const renameBtn = (x) =>
    `<button class="btn btn-ghost btn-sm" onclick="Masters.rename('${which}','${x.id}')">Rename</button>`;
  const rows = list
    .map((x) =>
      which === "projects"
        ? `<tr><td class="mono">${esc(x.code)}</td><td>${esc(x.name)}</td><td>${statusPill(x)}</td><td style="text-align:right">${renameBtn(x)} ${toggleBtn(x)}</td></tr>`
        : `<tr><td>${esc(x.name)}</td><td>${statusPill(x)}</td><td style="text-align:right">${renameBtn(x)} ${toggleBtn(x)}</td></tr>`,
    )
    .join("");
  const colspan = which === "projects" ? 4 : 3;
  $("#content").innerHTML =
    `<div class="toolbar">${tabs.map((t) => `<button class="btn ${t === which ? "btn-primary" : "btn-ghost"} btn-sm" onclick="Views._master('${t}')">${t}</button>`).join("")}</div>
    <div class="card"><div class="card-pad" style="display:flex;align-items:center;border-bottom:1px solid var(--line)"><h3 style="text-transform:capitalize">${which}</h3><button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="Masters.add('${which}')">+ Add</button></div><div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows || `<tr><td colspan="${colspan}"><div class="empty">None yet</div></td></tr>`}</tbody></table></div></div>`;
};

Views.audit = async function () {
  const log = await api("GET", "/audit");
  $("#content").innerHTML =
    `<div class="card"><div class="table-wrap"><table><thead><tr><th>Time</th><th>User</th><th>Role</th><th>Action</th><th>Entity</th><th>Ref</th><th>Detail</th></tr></thead><tbody>${log.map((a) => `<tr><td class="mono" style="white-space:nowrap">${fmtDT(a.at)}</td><td>${esc(a.user_name || "—")}</td><td><span class="tag">${ROLES[a.role] || a.role || "—"}</span></td><td><b>${esc(a.action)}</b></td><td>${esc(a.entity || "—")}</td><td class="mono">${esc(a.entity_id || "—")}</td><td class="csub" style="margin:0">${esc(a.detail || "")}</td></tr>`).join("") || '<tr><td colspan="7"><div class="empty">No activity</div></td></tr>'}</tbody></table></div></div>`;
};

/* ============ local expense draft ============ */

const ExpenseDraft = {
  dbName: "sitexpense-local",
  storeName: "drafts",
  key: "current",

  async db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async save(data) {
    const db = await this.db();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      tx.objectStore(this.storeName).put(data, this.key);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async load() {
    const db = await this.db();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const req = tx.objectStore(this.storeName).get(this.key);

      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },

  async clear() {
    const db = await this.db();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      tx.objectStore(this.storeName).delete(this.key);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};

/* ============ expense form ============ */
const ExpenseForm = {
  files: [],
  previewUrls: [],

  async loadDraft() {
    const draft = await ExpenseDraft.load();
    if (!draft) return false;

    this.files = draft.files || [];

    const fields = draft.fields || {};

    const values = {
      "ef-date": fields.date || new Date().toISOString().slice(0, 10),
      "ef-amt": fields.amount || "",
      "ef-cat": fields.categoryId || "",
      "ef-det": fields.details || "",
      "ef-prj": fields.projectId || "",
      "ef-loc": fields.location || "",
      "ef-by": fields.expenseDoneBy || S.user.name,
      "ef-billrec": fields.billReceived || "No",
      "ef-billno": fields.billNo || "",
      "ef-paid": fields.paid ?? "0",
      "ef-rem": fields.remark || "",
    };

    for (const [id, value] of Object.entries(values)) {
      const el = $("#" + id);
      if (el) el.value = value;
    }

    this.preview();
    return true;
  },

  chooseDraft() {
    return new Promise((resolve) => {
      this._draftChoiceResolve = resolve;

      Modal.open(`
        <div class="modal-head">
          <h3>Saved Expense Draft Found</h3>
        </div>
        <div class="modal-body">
          <p style="margin:0;color:var(--muted)">
            You have an unfinished expense saved on this device.
            Would you like to continue it or start a new expense?
          </p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" onclick="ExpenseForm.finishDraftChoice(false)">
            Start New
          </button>
          <button class="btn btn-primary" onclick="ExpenseForm.finishDraftChoice(true)">
            Continue Draft
          </button>
        </div>
      `);
    });
  },

  finishDraftChoice(loadDraft) {
    const resolve = this._draftChoiceResolve;
    this._draftChoiceResolve = null;
    Modal.close();
    if (resolve) resolve(loadDraft);
  },

  async open() {
    const existingDraft = await ExpenseDraft.load();

    if (existingDraft) {
      const useDraft = await this.chooseDraft();

      if (!useDraft) {
        await ExpenseDraft.clear();
        this.files = [];
        this._startedNew = true;
      }
    }

    const cats = S.categories,
      prj = S.projects,
      loc = S.locations;
    const opt = (arr, lab) =>
      arr
        .map((x) => `<option value="${x.id}">${esc(lab(x))}</option>`)
        .join("");
    Modal.open(`<div class="modal-head"><h3>New Expense Entry</h3><button class="x" onclick="Modal.close()">×</button></div>
      <div class="modal-body">
        <div class="frow three">
          <div class="field"><label>Date *</label><input type="date" id="ef-date" value="${new Date().toISOString().slice(0, 10)}"${["site", "checker"].includes(S.user.role) ? ` min="${new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)}"` : ""}></div>
          <div class="field"><label>Amount (₹) *</label><input type="number" id="ef-amt" step="0.01" min="0" placeholder="0.00"></div>
          <div class="field"><label>Category *</label><select id="ef-cat">${opt(cats, (x) => x.name)}</select></div>
        </div>
        <div class="field full"><label>Expense Details *</label><textarea id="ef-det" rows="2" placeholder="e.g. Diesel for Scorpio BR01PJ8719"></textarea></div>
        <div class="frow three">
          <div class="field"><label>Project *</label><select id="ef-prj">${opt(prj, (x) => x.code + " · " + x.name)}</select></div>
          <div class="field"><label>Location</label><input id="ef-loc" list="ef-loc-list" placeholder="Type or pick a location" autocomplete="off"><datalist id="ef-loc-list">${loc.map((x) => `<option value="${esc(x.name)}"></option>`).join("")}</datalist></div>
          <div class="field"><label>Done by</label><input id="ef-by" value="${esc(S.user.name)}"></div>
        </div>
        <div class="frow">
          <div class="field"><label>Bill received?</label><select id="ef-billrec"><option>No</option><option>Yes</option></select></div>
          <div class="field"><label>Bill No.</label><input id="ef-billno" placeholder="optional"></div>
        </div>
        <div class="frow">
          <div class="field"><label>Payment</label><select id="ef-paid"><option value="0">Unpaid</option><option value="1">Paid</option></select></div>
          <div class="field"></div>
        </div>
        <div class="field full"><label>Remark</label><input id="ef-rem" placeholder="optional"></div>
        <div class="section-t">Evidence photos</div>
        <div class="drop" onclick="$('#ef-file').click()">📎 Tap to attach bill / payment / item photos or PDF
          <input type="file" id="ef-file" accept="image/*,application/pdf" multiple style="display:none" onchange="ExpenseForm.addFiles(this.files)"></div>
        <div class="thumbs" id="ef-thumbs"></div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-ghost" onclick="ExpenseForm.saveDraft()">Save Draft</button>
        <button class="btn btn-primary" onclick="ExpenseForm.submit(false)">Submit for review</button></div>`);

    if (existingDraft && !this._startedNew) {
      await this.loadDraft();
      toast("Saved draft loaded", "ok");
    }

    this._startedNew = false;
  },
  addFiles(newFiles) {
    const duplicates = [];

    for (const file of newFiles) {
      const duplicate = this.files.some(
        (existing) =>
          existing.name === file.name &&
          existing.size === file.size &&
          existing.lastModified === file.lastModified &&
          existing.type === file.type,
      );

      if (duplicate) {
        duplicates.push(file.name);
      } else {
        this.files.push(file);
      }
    }

    this.preview();
    $("#ef-file").value = "";

    if (duplicates.length) {
      toast(
        duplicates.length === 1
          ? `${duplicates[0]} is already attached`
          : `${duplicates.length} selected files are already attached`,
        "err",
      );
    }
  },

  removeFile(index) {
    this.files.splice(index, 1);
  },

  preview() {
    this.previewUrls.forEach((url) => URL.revokeObjectURL(url));
    this.previewUrls = [];

    const files = this.files;

    $("#ef-thumbs").innerHTML = [...files]
      .map((f, index) => {
       const removeButton = `
  <button type="button"
    onclick="event.stopPropagation(); ExpenseForm.removeFile(${index}); ExpenseForm.preview();"
    style="position:absolute;top:4px;right:4px;width:24px;height:24px;padding:0;border:1px solid #999;border-radius:50%;background:#fff;color:#000;font-size:18px;line-height:20px;font-weight:bold;cursor:pointer;z-index:10;">
    ×
  </button>
`;

        if (f.type === "application/pdf") {
          return `
          <div class="thumb" style="position:relative;display:flex;align-items:center;justify-content:center;font-size:11px;text-align:center;padding:4px;overflow:hidden">
            ${removeButton}
            📄<br>${esc(f.name)}
          </div>
        `;
        }

        const url = URL.createObjectURL(f);
        this.previewUrls.push(url);

        return `
      <div class="thumb" style="position:relative">
        ${removeButton}
        <img src="${url}">
      </div>
    `;
      })
      .join("");
  },

  async saveDraft() {
    const fields = {
      date: $("#ef-date").value,
      amount: $("#ef-amt").value,
      categoryId: $("#ef-cat").value,
      details: $("#ef-det").value,
      projectId: $("#ef-prj").value,
      location: $("#ef-loc").value,
      expenseDoneBy: $("#ef-by").value,
      billReceived: $("#ef-billrec").value,
      billNo: $("#ef-billno").value,
      paid: $("#ef-paid").value,
      remark: $("#ef-rem").value,
    };

    try {
      await ExpenseDraft.save({
        fields,
        files: this.files,
      });

      toast("Draft saved locally", "ok");
    } catch (e) {
      toast("Draft could not be saved. Please try again.", "err");
    }
  },

  async submit(asDraft, confirmDuplicate) {
    const fd = new FormData();
    const map = {
      date: "ef-date",
      amount: "ef-amt",
      categoryId: "ef-cat",
      details: "ef-det",
      projectId: "ef-prj",
      location: "ef-loc",
      expenseDoneBy: "ef-by",
      billReceived: "ef-billrec",
      billNo: "ef-billno",
      paid: "ef-paid",
      remark: "ef-rem",
    };
    for (const k in map) fd.append(k, $("#" + map[k]).value);
    fd.append("asDraft", asDraft ? "true" : "false");
    if (confirmDuplicate) fd.append("confirmDuplicate", "true");
    const files = this.files;
    for (const f of files) fd.append("photos", f);
    if (
      !$("#ef-date").value ||
      !$("#ef-amt").value ||
      !$("#ef-det").value.trim()
    ) {
      toast("Date, amount and details required", "err");
      return;
    }
    if (!asDraft && files.length === 0) {
      toast("Attach at least one file before submitting", "err");
      return;
    } // P10
    try {
      const r = await api("POST", "/expenses", fd, true);
      await ExpenseDraft.clear();
      this.files = [];
      Modal.close();
      toast(r.voucherNo + (asDraft ? " saved" : " submitted"), "ok");
      await buildNav();
      go(S.page);
    } catch (e) {
      if (e.data && e.data.duplicate) {
        if (confirm(e.message)) return ExpenseForm.submit(asDraft, true);
        return;
      } // P13
      toast(e.message, "err");
    }
  },
};

/* ============ detail + workflow ============ */
const Detail = {
  async open(id) {
    let e;
    try {
      e = await api("GET", "/expenses/" + id);
    } catch (err) {
      toast(err.message, "err");
      return;
    }
    const dl = (k, v) => `<div class="dl">${k}</div><div class="dv">${v}</div>`;
    const isPdf = (f) =>
      f.mime === "application/pdf" || /\.pdf$/i.test(f.original_name || "");
    const ev = e.evidence.length
      ? `<div class="thumbs">${e.evidence
          .map((f) =>
            isPdf(f)
              ? `<a class="thumb" href="/api/evidence/${f.id}" target="_blank" rel="noopener" title="${esc(f.original_name || "PDF")}" style="display:flex;flex-direction:column;align-items:center;justify-content:center;text-decoration:none;color:inherit">📄<span style="font-size:10px;max-width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.original_name || "PDF")}</span></a>`
              : `<div class="thumb" onclick="Detail.viewImg('${f.id}')"><img src="/api/evidence/${f.id}"></div>`,
          )
          .join("")}</div>`
      : '<div class="csub" style="margin:0">No evidence attached.</div>';
    const acts = Detail.actions(e);
    const tl = e.history
      .slice()
      .reverse()
      .map(
        (h) =>
          `<div class="tl"><div style="font-weight:600;font-size:13px">${esc(h.action)}</div><div class="q-meta">${esc(h.byName)} · ${fmtDT(h.at)}</div>${h.detail ? `<div class="csub" style="margin:2px 0 0">${esc(h.detail)}</div>` : ""}</div>`,
      )
      .join("");
    const q = e.queries.length
      ? e.queries.map((qq) => Detail.queryCard(qq, e)).join("")
      : '<div class="csub" style="margin:0">No queries raised.</div>';
    Modal.open(`<div class="modal-head"><h3>${esc(e.voucher_no)}</h3> ${pill(e.status)} ${previousDelayBadge(e)} ${overallSlaBadge(e)} ${slaBadge(e)}<button class="x" onclick="Modal.close()">×</button></div>
      <div class="modal-body">
        <div class="detail-grid">${dl("Date", fmtDate(e.date))}${dl("Amount", `<b class="mono">${money(e.amount)}</b>`)}${dl("Category", `<span class="tag">${esc(e.categoryName)}</span>`)}${dl("Project", esc(e.projectName))}${dl("Location", esc(e.locationName))}${dl("Done by", esc(e.expense_done_by || "—"))}${dl("Bill", esc(e.bill_received || "—") + (e.bill_no ? ` (${esc(e.bill_no)})` : ""))}${dl("Payment", e.paid ? `Paid${e.paid_at ? " · " + fmtDate(Number(e.paid_at)) : ""}` : "Unpaid")}</div>
        <div class="dl" style="border:0">Details</div><div class="dv" style="border:0;padding-top:2px">${esc(e.details)}</div>
        ${e.remark ? `<div class="dl" style="border:0;margin-top:6px">Remark</div><div class="dv" style="border:0;padding-top:2px">${esc(e.remark)}</div>` : ""}
        <div class="section-t">Evidence</div>${ev}
        <div class="section-t">Review Progress</div>${Detail.ladder(e)}
        ${acts.length ? `<div class="section-t">Actions</div><div class="actions-bar">${acts.join("")}</div>` : ""}
        <div class="section-t">Queries</div>${q}
        <div class="section-t">History</div><div class="timeline">${tl}</div>
      </div>
      <div class="modal-foot">
          ${
            e.status === "Approved" &&
            !e.paid &&
            ["accounts", "admin"].includes(S.user.role)
              ? `<button class="btn btn-ghost" onclick="Views._downloadPayment('${e.id}')">Download Payment</button>`
              : ""
          }
          <button class="btn btn-ghost" onclick="Modal.close()">Close</button>
        </div>`);
  },
  ladder(e) {
    const ap = e.approvals || {};
    const steps = [
      ["check", "Level 1 — Checked"],
      ["purchase", "Level 2 — Purchase Reviewed"],
      ["operations", "Level 3 — Operations Reviewed"],
      ["accounts", "Level 4 — Accounts Reviewed"],
      ["approved", "Final — Approved"],
    ];
    const nowMap = {
      Submitted: "check",
      Checked: "purchase",
      "Purchase Reviewed": "operations",
      "Operations Reviewed": "accounts",
      "Accounts Reviewed": "approved",
    };
    return steps
      .map(([k, label], i) => {
        const a = ap[k];
        let cls = "wait",
          mark = i < 4 ? i + 1 : "✓",
          meta = "Awaiting";
        if (a) {
          cls = "done";
          mark = "✓";
          meta = userName(a.by) + " · " + fmtDT(a.at);
        } else if (nowMap[e.status] === k) {
          cls = "now";
          meta = "Pending now";
        }
        return `<div class="lvl"><div class="dot ${cls}">${mark}</div><div><div class="lt">${label}</div><div class="lm">${esc(meta)}</div></div></div>`;
      })
      .join("");
  },
  actions(e) {
    const r = S.user.role,
      a = [],
      s = e.status,
      admin = r === "admin";
    if (s === "Submitted" && (r === "checker" || admin))
      a.push(
        `<button class="btn btn-primary btn-sm" onclick="Detail.advance('${e.id}','check')">✓ Mark Checked</button>`,
      );
    if (s === "Checked" && (r === "purchase" || admin))
      a.push(
        `<button class="btn btn-primary btn-sm" onclick="Detail.advance('${e.id}','purchase')">✓ Review (Purchase)</button>`,
      );
    if (s === "Purchase Reviewed" && (r === "operations" || admin))
      a.push(
        `<button class="btn btn-primary btn-sm" onclick="Detail.advance('${e.id}','operations')">✓ Review (Operations)</button>`,
      );
    if (
      s === "Operations Reviewed" &&
      (["accounts", "account_checker"].includes(r) || admin)
    )
      a.push(
        `<button class="btn btn-primary btn-sm" onclick="Detail.advance('${e.id}','accounts')">✓ Review (Accounts)</button>`,
      );
    if (s === "Accounts Reviewed" && (r === "accounts" || admin))
      a.push(
        `<button class="btn btn-primary btn-sm" style="background:var(--green)" onclick="Detail.advance('${e.id}','approve')">✓ Approve</button>`,
      );
    if (
      [
        "Submitted",
        "Checked",
        "Purchase Reviewed",
        "Operations Reviewed",
        "Accounts Reviewed",
      ].includes(s) &&
      can.review()
    ) {
      a.push(
        `<button class="btn btn-ghost btn-sm" onclick="Detail.raiseQuery('${e.id}')">? Raise Query</button>`,
      );
      a.push(
        `<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="Detail.reject('${e.id}')">✕ Reject</button>`,
      );
    }
    if (
      r === "site" &&
      e.created_by === S.user.id &&
      ["Draft", "Submitted", "Query"].includes(s)
    )
      a.push(
        `<button class="btn btn-ghost btn-sm" onclick="ExpenseForm._editNote()">✎ Edit on web</button>`,
      );
    return a;
  },
  async advance(id, step, reason) {
    try {
      await api(
        "POST",
        `/expenses/${id}/advance/${step}`,
        reason ? { reason } : undefined,
      );
      toast("Updated", "ok");
      Modal.close();
      await buildNav();
      go(S.page);
    } catch (e) {
      if (e.data && e.data.needReason) {
        const r = prompt(
          "This voucher is overdue. Enter a reason for the delay to proceed:",
        );
        if (r && r.trim()) return Detail.advance(id, step, r.trim());
        return;
      }
      toast(e.message, "err");
    }
  },
  reject(id) {
    Modal.open(
      `<div class="modal-head"><h3>Reject Expense</h3><button class="x" onclick="Detail.open('${id}')">×</button></div><div class="modal-body"><div class="field full"><label>Reason *</label><textarea id="rj" rows="3"></textarea></div></div><div class="modal-foot"><button class="btn btn-ghost" onclick="Detail.open('${id}')">Back</button><button class="btn btn-primary" style="background:var(--red)" onclick="Detail.doReject('${id}')">Reject</button></div>`,
    );
  },
  async doReject(id) {
    const reason = $("#rj").value.trim();
    if (!reason) {
      toast("Reason required", "err");
      return;
    }
    try {
      await api("POST", `/expenses/${id}/reject`, { reason });
      toast("Rejected", "ok");
      Modal.close();
      await buildNav();
      go(S.page);
    } catch (e) {
      toast(e.message, "err");
    }
  },
  raiseQuery(id) {
    Modal.open(
      `<div class="modal-head"><h3>Raise Query</h3><button class="x" onclick="Detail.open('${id}')">×</button></div><div class="modal-body"><div class="csub" style="margin:0 0 10px">This query goes to the site person who created this voucher. When they resolve it, the voucher is re-submitted and the whole chain (checker → purchase → operations → accounts) re-approves.</div><div class="field full"><label>Query *</label><textarea id="q-msg" rows="3" placeholder="What needs to be clarified or corrected?"></textarea></div></div><div class="modal-foot"><button class="btn btn-ghost" onclick="Detail.open('${id}')">Back</button><button class="btn btn-primary" onclick="Detail.doRaiseQuery('${id}')">Send</button></div>`,
    );
  },
  async doRaiseQuery(id) {
    const text = $("#q-msg").value.trim();
    if (!text) {
      toast("Enter the query", "err");
      return;
    }
    try {
      await api("POST", `/expenses/${id}/query`, { text });
      toast("Query sent", "ok");
      Modal.close();
      await buildNav();
      go(S.page);
    } catch (e) {
      toast(e.message, "err");
    }
  },
  queryCard(q, e) {
    const meCreator = !!(e && e.created_by === S.user.id);
    const canResolve =
      q.status === "Open" &&
      (q.assigned_to === S.user.id || S.user.role === "admin" || meCreator);
    const canReply =
      q.status === "Open" &&
      ([q.assigned_to, q.raised_by].includes(S.user.id) || meCreator);
    return `<div class="query-item"><div style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><span class="pill ${q.status === "Open" ? "p-qry" : "p-app"}">${q.status}</span><span class="csub" style="margin:0">${esc(q.raisedByName)} → ${esc(q.assignedToName)}</span></div>${q.thread.map((m) => `<div class="q-msg">${esc(m.text)}<div class="q-meta">${esc(m.byName)} · ${fmtDT(m.at)}</div></div>`).join("")}${canReply ? `<div style="margin-top:8px;display:flex;gap:8px"><input id="qr-${q.id}" placeholder="Reply…" style="flex:1;padding:8px 10px;border:1px solid var(--line);border-radius:7px"><button class="btn btn-ghost btn-sm" onclick="Detail.reply('${q.id}','${q.expense_id}')">Reply</button>${canResolve ? `<button class="btn btn-primary btn-sm" onclick="Detail.resolve('${q.id}','${q.expense_id}')">Resolve</button>` : ""}</div><div style="margin-top:6px"><input type="file" id="qf-${q.id}" accept="image/*,application/pdf" multiple style="display:none" onchange="Detail.attach('${q.id}','${q.expense_id}')"><button class="btn btn-ghost btn-sm" onclick="$('#qf-${q.id}').click()">📎 Add photo / PDF</button></div>` : ""}</div>`;
  },
  async reply(qid, eid) {
    const v = $("#qr-" + qid).value.trim();
    if (!v) return;
    try {
      await api("POST", `/queries/${qid}/reply`, { text: v });
      Detail.open(eid);
    } catch (e) {
      toast(e.message, "err");
    }
  },
  async resolve(qid, eid, reason) {
    try {
      await api(
        "POST",
        `/queries/${qid}/resolve`,
        reason ? { reason } : undefined,
      );
      toast("Resolved", "ok");
      Modal.close();
      await buildNav();
      go(S.page);
    } catch (e) {
      if (e.data && e.data.needReason) {
        const r = prompt(
          "Query resolution is overdue. Enter a reason for the delay to proceed:",
        );
        if (r && r.trim()) return Detail.resolve(qid, eid, r.trim());
        return;
      }
      toast(e.message, "err");
    }
  },
  async attach(qid, eid) {
    const inp = $("#qf-" + qid);
    if (!inp || !inp.files.length) return;
    const fd = new FormData();
    for (const f of inp.files) fd.append("files", f);
    try {
      await api("POST", `/queries/${qid}/attach`, fd, true);
      toast("Attached", "ok");
      Detail.open(eid);
    } catch (e) {
      toast(e.message, "err");
    }
  },
  viewImg(id) {
    const overlay = document.createElement("div");

    overlay.className = "modal-bg";
    overlay.style.zIndex = "1001";

    overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <h3>Evidence</h3>
        <button class="x" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <div class="modal-body" style="text-align:center">
        <img src="/api/evidence/${id}" style="max-width:100%;border-radius:8px">
      </div>
    </div>
  `;

    overlay.onclick = (event) => {
      if (event.target === overlay) overlay.remove();
    };

    document.querySelector("#modalRoot").appendChild(overlay);
  },
};
ExpenseForm._editNote = () =>
  toast("Editing is available on the desktop view in this build", "ok");

/* ============ funds / users / masters admin ============ */
const FundsAdmin = {
  add() {
    Modal.open(
      `<div class="modal-head">
        <h3>Release Funds to Project</h3>
        <button class="x" onclick="Modal.close()">×</button>
      </div>
      <div class="modal-body">

        <div class="card" style="margin-bottom:16px;background:var(--green-soft);border:0">
          <div class="card-pad">
            <div class="lab">Admin Fund Balance</div>
            <div class="val" style="font-size:24px;color:var(--green)">
              ${money(FundsAdmin._adminFundBalance || 0)}
            </div>
            <div class="csub" style="margin:0">
              Available to release to projects
            </div>
          </div>
        </div>

        <div class="frow">
          <div class="field">
            <label>Project *</label>
            <select id="fd-prj">
              ${S.projects
                .filter((p) => p.code !== "ADMIN-FUND")
                .map(
                  (p) =>
                    `<option value="${p.id}">
                      ${esc(p.code)} · ${esc(p.name)}
                    </option>`,
                )
                .join("")}
            </select>
          </div>

          <div class="field">
            <label>Date *</label>
            <input
              type="date"
              id="fd-date"
              value="${new Date().toISOString().slice(0, 10)}"
            >
          </div>
        </div>

        <div class="field full">
          <label>Amount (₹) *</label>
          <input
            type="number"
            id="fd-amt"
            step="0.01"
            min="0"
            max="${FundsAdmin._adminFundBalance || 0}"
          >
        </div>

        <div class="field full">
          <label>Note</label>
          <input
            id="fd-note"
            placeholder="e.g. transfer to project"
          >
        </div>

      </div>

      <div class="modal-foot">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-primary" onclick="FundsAdmin.save()">Release Funds</button>
      </div>`,
    );
  },
  async save() {
    const body = {
      projectId: $("#fd-prj").value,
      date: $("#fd-date").value,
      amount: $("#fd-amt").value,
      note: $("#fd-note").value.trim(),
    };

    if (!body.projectId || !body.date || !body.amount) {
      toast("Project, date and amount required", "err");
      return;
    }

    const amount = Number(body.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      toast("Enter a valid amount", "err");
      return;
    }

    if (amount > (FundsAdmin._adminFundBalance || 0)) {
      toast("Amount exceeds Admin Fund balance", "err");
      return;
    }

    try {
      await api("POST", "/funds", body);

      Modal.close();
      toast("Funds released to project", "ok");
      go("funds");
    } catch (e) {
      toast(e.message, "err");
    }
  },
  allocate() {
    const sites = S.users.filter((u) => u.role === "site" && u.active);
    Modal.open(
      `<div class="modal-head"><h3>Allocate Funds to Site</h3><button class="x" onclick="Modal.close()">×</button></div><div class="modal-body"><div class="frow"><div class="field"><label>Project *</label><select id="al-prj">${S.projects.map((p) => `<option value="${p.id}">${esc(p.code)} · ${esc(p.name)}</option>`).join("")}</select></div><div class="field"><label>Site *</label><select id="al-site">${sites.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select></div></div><div class="frow"><div class="field"><label>Amount (₹) *</label><input type="number" id="al-amt" step="0.01" min="0"></div><div class="field"><label>Date *</label><input type="date" id="al-date" value="${new Date().toISOString().slice(0, 10)}"></div></div><div class="field full"><label>Note</label><input id="al-note" placeholder="optional"></div></div><div class="modal-foot"><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button><button class="btn btn-primary" onclick="FundsAdmin.saveAllocate()">Allocate</button></div>`,
    );
  },
  async saveAllocate() {
    const body = {
      projectId: $("#al-prj").value,
      toUser: $("#al-site").value,
      amount: $("#al-amt").value,
      date: $("#al-date").value,
      note: $("#al-note").value.trim(),
    };
    if (!body.projectId || !body.toUser || !body.amount || !body.date) {
      toast("Project, site, amount and date required", "err");
      return;
    }
    try {
      await api("POST", "/funds/allocate", body);
      Modal.close();
      toast("Allocated to site", "ok");
      go("funds");
    } catch (e) {
      toast(e.message, "err");
    }
  },
};
const BudgetsAdmin = {
  set() {
    const curMonth = new Date().toISOString().slice(0, 7);
    Modal.open(
      `<div class="modal-head"><h3>Set Monthly Budget</h3><button class="x" onclick="Modal.close()">×</button></div><div class="modal-body"><div class="frow"><div class="field"><label>Project *</label><select id="bg-prj">${S.projects.map((p) => `<option value="${p.id}">${esc(p.code)} · ${esc(p.name)}</option>`).join("")}</select></div><div class="field"><label>Month *</label><input type="month" id="bg-period" value="${curMonth}"></div></div><div class="field full"><label>Budget (₹) *</label><input type="number" id="bg-amt" step="0.01" min="0"></div></div><div class="modal-foot"><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button><button class="btn btn-primary" onclick="BudgetsAdmin.save()">Save</button></div>`,
    );
  },
  async save() {
    const body = {
      projectId: $("#bg-prj").value,
      period: $("#bg-period").value,
      amount: $("#bg-amt").value,
    };
    if (!body.projectId || !body.period || !body.amount) {
      toast("Project, month and amount required", "err");
      return;
    }
    try {
      await api("POST", "/budgets", body);
      Modal.close();
      toast("Budget saved", "ok");
      go("analytics");
    } catch (e) {
      toast(e.message, "err");
    }
  },
};
const AccountCheckerAdmin = {
  edit(id) {
    const u = id ? (Views._accountCheckers || []).find((x) => x.id === id) : null;
    const chips = S.allProjects.filter((p) => p.active).map((p) => `<span class="chip ${u && !u.all_projects && u.project_ids.includes(p.id) ? "on" : ""}" data-pid="${p.id}" onclick="this.classList.toggle('on')">${esc(p.code)} · ${esc(p.name)}</span>`).join("");
    const allOn = u ? u.all_projects : false;
    Modal.open(`<div class="modal-head"><h3>${u ? "Edit Account Checker" : "Create Account Checker"}</h3><button class="x" onclick="Modal.close()">×</button></div><div class="modal-body"><div class="frow"><div class="field"><label>Full name *</label><input id="ac-name" value="${esc(u ? u.name : "")}"></div><div class="field"><label>Username *</label><input id="ac-user" value="${esc(u ? u.username : "")}"></div></div><div class="frow"><div class="field"><label>Profile / Role</label><input value="Account Checker" disabled></div><div class="field"><label>${u ? "Reset password" : "Password *"}</label><input id="ac-pass" type="password" placeholder="${u ? "leave blank to keep" : "set a password"}"></div></div><div class="field full"><label>Project access</label><label style="display:flex;gap:8px;align-items:center;text-transform:none;letter-spacing:0;color:var(--ink);margin:4px 0 8px"><input type="checkbox" id="ac-all" ${allOn ? "checked" : ""} onchange="$('#ac-chips').style.opacity=this.checked?.4:1;$('#ac-chips').style.pointerEvents=this.checked?'none':'auto'"> All projects (head office)</label><div class="chips" id="ac-chips" style="${allOn ? "opacity:.4;pointer-events:none" : ""}">${chips}</div></div></div><div class="modal-foot"><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button><button class="btn btn-primary" onclick="AccountCheckerAdmin.save(${u ? `'${u.id}'` : "null"})">Save</button></div>`);
  },
  async save(id) {
    const password = $("#ac-pass").value;
    const allProjects = $("#ac-all").checked;
    const body = { name: $("#ac-name").value.trim(), username: $("#ac-user").value.trim(), allProjects, projectIds: allProjects ? [] : $$("#ac-chips .chip.on").map((c) => c.dataset.pid) };
    if (password) body.password = password;
    if (!body.name || !body.username || (!id && !password)) {
      toast(id ? "Name and username required" : "Name, username and password required", "err");
      return;
    }
    try {
      await api(id ? "PATCH" : "POST", id ? `/account-checkers/${id}` : "/account-checkers", body);
      Modal.close();
      toast("Saved", "ok");
      go("accountCheckers");
    } catch (e) { toast(e.message, "err"); }
  },
  async toggle(id) {
    try { await api("POST", `/account-checkers/${id}/toggle`); go("accountCheckers"); }
    catch (e) { toast(e.message, "err"); }
  },
};

const UsersAdmin = {
  changePassword() {
    Modal.open(`<div class="modal-head"><h3>Change Password</h3><button class="x" onclick="Modal.close()">×</button></div><div class="modal-body"><div class="field"><label>New password *</label><input id="self-pass" type="password" autocomplete="new-password"></div></div><div class="modal-foot"><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button><button class="btn btn-primary" onclick="UsersAdmin.savePassword()">Change Password</button></div>`);
  },
  async savePassword() {
    const password = $("#self-pass").value;
    if (!password) { toast("Password is required", "err"); return; }
    try { await api("POST", "/me/password", { password }); Modal.close(); toast("Password changed", "ok"); }
    catch (e) { toast(e.message, "err"); }
  },
  edit(id) {
    const u = id ? (Views._users || []).find((x) => x.id === id) : null;
    const chips = S.allProjects
      .filter((p) => p.active)
      .map(
        (p) =>
          `<span class="chip ${u && !u.all_projects && u.project_ids.includes(p.id) ? "on" : ""}" data-pid="${p.id}" onclick="this.classList.toggle('on')">${esc(p.code)} · ${esc(p.name)}</span>`,
      )
      .join("");
    const allOn = u ? u.all_projects : false;
    Modal.open(`<div class="modal-head"><h3>${u ? "Edit User" : "Create User"}</h3><button class="x" onclick="Modal.close()">×</button></div><div class="modal-body">
      <div class="frow"><div class="field"><label>Full name *</label><input id="us-name" value="${esc(u ? u.name : "")}"></div><div class="field"><label>Username *</label><input id="us-user" value="${esc(u ? u.username : "")}"></div></div>
      <div class="frow"><div class="field"><label>Profile / Role *</label><select id="us-role">${Object.entries(
        ROLES,
      )
        .map(
          ([k, v]) =>
            `<option value="${k}" ${u && u.role === k ? "selected" : ""}>${v}</option>`,
        )
        .join(
          "",
        )}</select></div><div class="field"><label>${u ? "Reset password" : "Password *"}</label><input id="us-pass" type="text" placeholder="${u ? "leave blank to keep" : "set a password"}"></div></div>
      <div class="field full"><label>Project access</label><label style="display:flex;gap:8px;align-items:center;text-transform:none;letter-spacing:0;color:var(--ink);margin:4px 0 8px"><input type="checkbox" id="us-all" ${allOn ? "checked" : ""} onchange="$('#us-chips').style.opacity=this.checked?.4:1;$('#us-chips').style.pointerEvents=this.checked?'none':'auto'"> All projects (head office)</label><div class="chips" id="us-chips" style="${allOn ? "opacity:.4;pointer-events:none" : ""}">${chips}</div></div>
    </div><div class="modal-foot"><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button><button class="btn btn-primary" onclick="UsersAdmin.save(${u ? `'${u.id}'` : "null"})">Save</button></div>`);
  },
  async save(id) {
    const allProjects = $("#us-all").checked;
    const body = {
      name: $("#us-name").value.trim(),
      username: $("#us-user").value.trim(),
      role: $("#us-role").value,
      allProjects,
      projectIds: allProjects
        ? []
        : $$("#us-chips .chip.on").map((c) => c.dataset.pid),
    };
    const pass = $("#us-pass").value;
    if (pass) body.password = pass;
    if (!body.name || !body.username) {
      toast("Name and username required", "err");
      return;
    }
    try {
      if (id) {
        await api("PATCH", "/users/" + id, body);
      } else {
        if (!pass) {
          toast("Password required for a new user", "err");
          return;
        }
        await api("POST", "/users", body);
      }
      Modal.close();
      toast("Saved", "ok");
      go("users");
    } catch (e) {
      toast(e.message, "err");
    }
  },
  async toggle(id) {
    try {
      await api("POST", `/users/${id}/toggle`);
      go("users");
    } catch (e) {
      toast(e.message, "err");
    }
  },
};
const Masters = {
  add(type) {
    const isProj = type === "projects";
    Modal.open(
      `<div class="modal-head"><h3>Add ${type.slice(0, -1)}</h3><button class="x" onclick="Modal.close()">×</button></div><div class="modal-body">${isProj ? `<div class="field"><label>Code *</label><input id="m-code" placeholder="e.g. DM"></div>` : ""}<div class="field full"><label>Name *</label><input id="m-name"></div></div><div class="modal-foot"><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button><button class="btn btn-primary" onclick="Masters.save('${type}')">Save</button></div>`,
    );
  },
  async save(type) {
    const body = { name: $("#m-name").value.trim() };
    if (type === "projects") body.code = $("#m-code").value.trim();
    if (!body.name || (type === "projects" && !body.code)) {
      toast("All fields required", "err");
      return;
    }
    try {
      await api("POST", "/masters/" + type, body);
      Modal.close();
      toast("Saved", "ok");
      await refreshLookups();
      Views._master(type);
    } catch (e) {
      toast(e.message, "err");
    }
  },
  async toggle(type, id) {
    try {
      await api("POST", `/masters/${type}/${id}/toggle`);
      await refreshLookups();
      Views._master(type);
    } catch (e) {
      toast(e.message, "err");
    }
  },
  rename(type, id) {
    const row = (Views._mastersData[type] || []).find((r) => r.id === id);
    if (!row) return;
    const isProj = type === "projects";
    Modal.open(
      `<div class="modal-head"><h3>Rename ${type.slice(0, -1)}</h3><button class="x" onclick="Modal.close()">×</button></div><div class="modal-body">${isProj ? `<div class="field"><label>Code *</label><input id="m-code" value="${esc(row.code || "")}"></div>` : ""}<div class="field full"><label>Name *</label><input id="m-name" value="${esc(row.name || "")}"></div></div><div class="modal-foot"><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button><button class="btn btn-primary" onclick="Masters.saveRename('${type}','${id}')">Save</button></div>`,
    );
  },
  async saveRename(type, id) {
    const body = { name: $("#m-name").value.trim() };
    if (type === "projects") body.code = $("#m-code").value.trim();
    if (!body.name || (type === "projects" && !body.code)) {
      toast("All fields required", "err");
      return;
    }
    try {
      await api("POST", `/masters/${type}/${id}/rename`, body);
      Modal.close();
      toast("Renamed", "ok");
      await refreshLookups();
      Views._master(type);
    } catch (e) {
      toast(e.message, "err");
    }
  },
};

/* ============ boot ============ */
window.go = go;
window.logout = logout;
window.Modal = Modal;
window.Views = Views;
window.ExpenseForm = ExpenseForm;
window.Detail = Detail;
window.FundsAdmin = FundsAdmin;
window.UsersAdmin = UsersAdmin;
window.Masters = Masters;
window.$ = $;
$("#lg-btn").addEventListener("click", doLogin);
$("#lg-pass").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doLogin();
});
$("#menu-btn").addEventListener("click", () =>
  $("#side").classList.toggle("open"),
);
boot().catch(() => showLogin());