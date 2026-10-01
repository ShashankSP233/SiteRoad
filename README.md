# SiteXpense — Node.js edition

A real client–server version of SiteXpense. One shared database, so **site phones at
different locations enter data and head office sees everything live** — the limitation
the single-file browser prototype could never overcome.

- **Server:** Node.js + Express
- **Database:** PostgreSQL, via the `pg` driver and a connection pool
- **Auth:** username/password, hashed with bcrypt, session in a signed cookie
- **Files:** evidence photos saved to `uploads/`, served only to permitted users
- **Front-end:** mobile-first single-page app in `public/` (works great on Android browsers)

## What it enforces (server-side, can't be bypassed)
- **Project-wise + profile-wise access** — each user has a role and either "all projects"
  (head office) or a list of allowed projects. Site users see only their own vouchers.
- **Sequential review** — Checker → Purchase → Operations → Accounts → *Approved*.
  Stages cannot be skipped or reordered; financial fields are frozen during review.
- **Funds & balance** — head office records money given per project; balance = given − spent.
- **Queries, rejections, full audit log, CSV export.**

## Run it locally
Requires Node.js 18+ (https://nodejs.org) and a PostgreSQL database to connect to.

**1. Get a Postgres database.** Either install it locally, or use a free-tier hosted
one (Supabase, Neon, and Render Postgres all have a no-cost tier that's plenty for
this) — a hosted one is usually the faster path since there's nothing to install.
Either way, you end up with a connection string that looks like:
```
postgresql://user:password@host:5432/dbname
```

**2. Set it as an environment variable and start the app:**
```bash
cd sitexpense-node
npm install
DATABASE_URL="postgresql://user:password@host:5432/dbname" npm start
```
Open http://localhost:3000

On Windows PowerShell, set the variable first, then start:
```powershell
$env:DATABASE_URL="postgresql://user:password@host:5432/dbname"
npm start
```

The first boot creates every table automatically and seeds demo data — nothing to run
by hand. If you'd rather not retype `DATABASE_URL` every time, most hosting platforms
let you set environment variables once in their dashboard; locally, a `.env` file plus
a loader like `dotenv` works too (not included here, to keep dependencies minimal).

> If the database is a managed cloud host, it almost certainly requires SSL — this is
> handled automatically (any host other than `localhost` gets SSL by default). Force it
> either way with `PGSSL=1` (on) or `PGSSL=0` (off) if auto-detection ever guesses wrong.

### Demo logins (created on first run)
| Username | Password | Role | Access |
|---|---|---|---|
| admin | admin123 | Administrator | all projects |
| site | site123 | Site Person | DM, MG only (sees own entries) |
| checker | check123 | Checker | all projects |
| purchase | pur123 | Purchase Reviewer | all projects |
| operations | ops123 | Operations Reviewer | all projects |
| accounts | acc123 | Accounts Manager | all projects |

> ⚠️ **Before real use:** these passwords are fixed in the source and documented here,
> so they must not stay active on a server real people can reach. Sign in as `admin` →
> **Users & Access**, and for each account still on a demo password, set a new one
> (Edit → Password) — or rename/deactivate it and create your own. The login screen
> itself no longer displays these credentials.

## Let phones reach head office
On your own network: run it on the office machine (pointed at your Postgres database)
and open `http://<that-machine-ip>:3000` from the phones.

For real multi-location use over the internet, deploy to any Node host (Render, Railway,
Fly.io, a small VPS) and point it at your Postgres database — most of these hosts also
offer Postgres directly, so the app and the database can live on the same platform. Set
these environment variables on the host:
```
PORT=3000
NODE_ENV=production
SESSION_SECRET=<a long random string>
SECURE_COOKIES=1
DATABASE_URL=<your Postgres connection string>
```
Put it behind HTTPS (most hosts do this automatically; `SECURE_COOKIES=1` then makes the
login cookie HTTPS-only — leave it unset on plain-localhost testing).

> With `NODE_ENV=production` set, the app **refuses to start** unless `SESSION_SECRET` is
> also set — no silent fallback to a guessable default. Login is rate-limited to 5 attempts
> per 15 minutes, tracked per IP+username so one person's failed attempts don't lock out
> anyone else on the same network.

## Project layout
```
server.js          Express app, sessions, login/logout, static hosting
src/db.js          Postgres connection pool, schema, seed data, shared helpers
src/api.js         All REST endpoints + access & workflow rules
public/index.html  App shell + login
public/styles.css  Mobile-first styling
public/app.js      Single-page front-end (talks to the API)
uploads/           Evidence images (created at runtime)
```

## Schema notes
Foreign keys are enforced with real `REFERENCES` constraints on every table — master
data is `ON DELETE RESTRICT`, child records like evidence/history/queries are
`ON DELETE CASCADE`. Money is stored as `BIGINT` paise (₹1 = 100), never floating-point —
the API still speaks rupees on both request and response, so this is invisible outside
`src/db.js`'s `toPaise`/`toRupees` helpers. Timestamps are epoch-milliseconds stored as
`BIGINT` too (an ordinary `INTEGER` can't hold a value that size). Structural schema
changes are tracked in a `schema_migrations` table so they run exactly once and are safe
to re-boot against.

`src/db.js` also carries a small compatibility layer (`db.prepare(sql).get/all/run()`,
async versions of the familiar SQLite-style calls) so the route handlers in `src/api.js`
read the same way they always have — just with `await` in front.

## Backups
Use your Postgres host's own backup/export tools (most managed hosts — Supabase, Render,
Neon, etc. — take automatic daily backups and let you restore to a point in time from
their dashboard). To do it yourself instead:
```bash
pg_dump "$DATABASE_URL" > backup.sql       # back up
psql "$DATABASE_URL" < backup.sql          # restore
```
Evidence photos live in `uploads/` on the server's own disk, separately from the
database — back that folder up too (and note that "ephemeral" hosting tiers on some
platforms wipe local disk on every redeploy, which would lose it; check your host's
docs if that matters to you).

## Resetting trial data
Ran a trial and want real entries on a clean slate? Stop the server, then:
```bash
npm run reset-data
```
This clears vouchers, evidence, queries, funds entries, and the audit log, and resets
voucher numbering to VCH-1001 — after a typed confirmation. **Your user accounts and
Masters (projects/categories/locations) are left exactly as they are** — so any renamed
projects or real site accounts you've already set up are safe.

Only if you want to throw away *everything*, including users and projects, and start
completely over:
```bash
npm run reset-data-full
```
This deletes every row in the database and re-seeds the original demo projects and the
default accounts, same as a brand new install. Most people want `reset-data`, not this.

## Notes / room to grow
- Evidence editing after submission and on-phone editing are intentionally minimal in this
  build; the desktop flow covers creation, review, funds, users and reports end-to-end.
- Add charts/analytics, email notifications, or a "lock after approval" rule as needed.
