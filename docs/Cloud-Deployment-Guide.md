# Cloud Deployment Guide (AWS or Azure)

**Status:** reference only. Cloud deployment is on hold by owner decision (2026-11-10), and no deployment phase is scheduled. This guide describes what a deployment would take so the work can be planned when it resumes. If it does, it becomes a new phase with its own plan and completion report (see `CLAUDE.md`, "Phases").

Cloud prices, free tiers, instance sizes and runtime versions change. Check every provider-specific detail below against the provider's current documentation at deployment time.

---

## 1. What the application needs from any host

These facts come from the code as of commit `17ba932`. They apply whichever provider is chosen.

| Need | Detail | Where it comes from |
|---|---|---|
| Node.js 26 | Pinned in `.nvmrc`; `engines` floor is `>=22.12.0` | `package.json` |
| One app process | Realtime is an in-memory hub fed by an in-process outbox processor, started from `src/instrumentation.ts`. A second instance would not deliver events to clients connected to the first. **Run exactly one instance; do not autoscale out.** | `src/infrastructure/realtime/realtime-hub.ts` |
| Long-lived HTTP connections | `/api/realtime/stream` is Server-Sent Events with a 25 s heartbeat. Proxies must not buffer it, and idle timeouts must exceed 25 s. | `src/app/api/realtime/stream/route.ts` |
| PostgreSQL 17 | Local and CI use `postgres:17-alpine`. Use the same major version. | `docker-compose.yml`, `.github/workflows/ci.yml` |
| `btree_gist` extension | Migration `0003` runs `CREATE EXTENSION IF NOT EXISTS btree_gist`. The migration chain fails without it. **Never tested on a managed service.** | `drizzle/migrations/0003_employee_overlap_constraints.sql` |
| Persistent file storage | Employee documents use `LocalFileStorage` only (no object-storage adapter yet). The path must survive restarts and redeploys, and be backed up. | `src/infrastructure/storage/` |
| HTTPS | Secure cookies are enabled only when `APP_BASE_URL` starts with `https://`. | `src/config/auth-env.ts` |
| Build-time internet | `next/font/google` downloads fonts during `next build`. | Phase 15 report |
| Health check | `GET /api/health` returns 200 when the database answers, otherwise 503. | `src/app/api/health/route.ts` |
| Logs | Structured JSON lines to stdout and stderr. | `src/infrastructure/logging/logger.ts` |
| DB connections | Pool of up to 10 connections per process. | `src/db/index.ts` |

### Environment variables

All are validated in `src/config/env.ts`. The app refuses to start sign-in without a valid secret.

| Variable | Production value |
|---|---|
| `NODE_ENV` | `production` |
| `APP_BASE_URL` | Public HTTPS URL, for example `https://ops.example.com` (also becomes `NEXTAUTH_URL`) |
| `NEXTAUTH_SECRET` | 32+ random characters, from the secret store. Never reuse a dev value. |
| `DATABASE_URL` | `postgresql://<user>:<password>@<host>:5432/restaurant_ops?sslmode=require` |
| `EMPLOYEE_DOCUMENT_STORAGE_PATH` | Absolute path on a persistent volume, outside the app directory and `public/` |
| `EMPLOYEE_DOCUMENT_MAX_BYTES` | Optional; default 10 MiB, max 50 MiB |
| `OUTBOX_POLL_INTERVAL_MS` | Optional; default 1000. Do not set it to 0 in production, because that turns off realtime. |
| `TEST_DATABASE_URL` | **Do not set.** Test tooling recreates that database. |
| `MESSAGING_EMAIL_PROVIDER` | Phase 22: `smtp` or `off`. Required in production; `capture` is refused. |
| `MESSAGING_SMS_PROVIDER` | Phase 22: `twilio` or `off`. Required in production; `capture` is refused. |
| `MESSAGING_SMTP_URL`, `MESSAGING_FROM_EMAIL` | With `smtp`: the provider's `smtps://` URL (from the secret store; it holds a password) and the sending address. Any SMTP service works (SES, Azure Communication Services, SendGrid, Mailgun, Postmark). Set up SPF, DKIM and DMARC for the sending domain. |
| `MESSAGING_TWILIO_ACCOUNT_SID`, `MESSAGING_TWILIO_AUTH_TOKEN`, `MESSAGING_TWILIO_FROM` | With `twilio`: the account, its token (secret store) and a sending number registered for business texting (US A2P 10DLC or toll-free verification). Keep Twilio's built-in STOP handling on. |
| `MESSAGING_SUPPRESSION_KEY` | Required with a real provider: 32+ random characters from the secret store. **Never rotate it**: the opt-out list is keyed with it. |
| `MESSAGE_DISPATCH_INTERVAL_MS`, `MESSAGE_MAX_ATTEMPTS`, `MESSAGE_RETENTION_DAYS` | Optional; defaults 2000, 8 and 90. |
| `PUBLIC_BOOKING_IP_THRESHOLD`, `PUBLIC_BOOKING_CONTACT_THRESHOLD` | Optional; public booking attempts per hour (30 per IP behind `AUTH_CLIENT_IP_HEADER`, 5 per contact). |

The public booking page (`/book/...`) and its APIs (`/api/public/...`) are reachable signed out. Put them behind the same HTTPS front door, set `AUTH_CLIENT_IP_HEADER` so per-IP throttling works, and consider a WAF rate rule for `/api/public/*`. Outbound HTTPS to Twilio and outbound SMTP (465 or 587) must be allowed from the app.

### Tooling on the deploy path

`npm run db:migrate` uses `drizzle-kit`, and `db:seed` and `bootstrap:owner` use `tsx`. Both are **dev dependencies**, so whatever runs these commands needs a full `npm ci`, not `npm ci --omit=dev`. Tooling reads `.env` files through `@next/env`, but real environment variables take precedence, so set them in the environment rather than writing a `.env` file to the server.

---

## 2. Application work before any deployment

These are code changes. They belong in the deployment phase's plan and need the usual tests and review.

1. **Database TLS verification.** `?sslmode=require` encrypts the connection but does not verify the server certificate. Verifying it (`verify-full` with the provider's CA bundle) needs a small change in `src/config/env.ts` and `src/db/index.ts` to pass the CA. It is recommended, not strictly required, for a POC on a private network.
2. **File storage.** Either mount a persistent volume for `LocalFileStorage`, or add an `S3FileStorage` or `AzureBlobFileStorage` adapter behind `FileStorageService`. The interface was built for this; domain code does not change.
3. **Login rate limiting.** There is none (Phase 2 report). Redis is not allowed, so use an in-process limiter (fine with one instance) or a PostgreSQL-backed one.
4. **Session extension.** Calling next-auth's `/api/auth/session` reissues the token for another 8 hours, so a stolen token can be kept alive until the user is disabled (Phase 2 report). Decide whether to cap absolute session lifetime.
5. **Optional: container image.** There is no `Dockerfile`. One is needed only for a container host (App Service for Containers, ECS, Container Apps). Setting `output: "standalone"` in `next.config.ts` makes the image much smaller.
6. **Housekeeping:**
   - re-run `npm audit --omit=dev` (it must be clean);
   - revisit DEV-002 and DEV-003, whose review triggers include "before any cloud deployment";
   - time the dashboard on the validation fixture, because it runs its queries twice (Phase 15 report).

---

## 3. Deployment steps common to both providers

1. **Provision** a network, a private managed PostgreSQL 17 server, one app host, and a persistent volume for documents (sections 4 and 5).
2. **Enable `btree_gist`** if the provider needs it allow-listed (Azure does; see 5.3). Then confirm it as the app's database user:
   ```sql
   CREATE EXTENSION IF NOT EXISTS btree_gist;
   ```
3. **Create the database and app user.** Use a dedicated `restaurant_app` login that owns `restaurant_ops`, not the provider's admin account.
4. **Store secrets** (`NEXTAUTH_SECRET`, the DB password or the whole `DATABASE_URL`) in the provider's secret store, and inject them into the process environment at start.
5. **Build:** `npm ci` then `npm run build` on a machine with Node 26 and internet access. That is either the app host or CI, shipping the built `.next/` with `node_modules`.
6. **Migrate:** `npm run db:migrate` against the cloud DB. Review the pending migrations first; never use schema push.
7. **Seed:** `npm run db:seed`. It is idempotent, keyed on `seed_runs`. **Never** run `db:seed:demo` or `db:seed:validation`; both refuse a non-loopback database anyway. `db:reset` also refuses non-loopback hosts.
8. **Create the owner:** `npm run bootstrap:owner`. It is interactive and needs a real terminal session on a host that can reach the DB. Never pass the password as an argument.
9. **Run** `npm run start` (port 3000) under a process supervisor that restarts it on failure, behind an HTTPS reverse proxy or the platform's TLS front end.
10. **Validate:**
    - `GET /api/health` returns 200;
    - sign in as the owner;
    - walk the canonical scenario (`CLAUDE.md`) on desktop, tablet and phone;
    - confirm kitchen tickets appear live, which proves SSE works through the proxy.

    The Playwright suite cannot be pointed at the cloud as is, because it recreates its own test database. An acceptance run needs a Playwright config that targets a base URL with no DB reset, against a disposable environment, never against real data.
11. **Operate:**
    - set a budget alert;
    - turn on automated DB backups and set a retention period;
    - snapshot or back up the documents volume;
    - ship stdout logs to the provider's log service.

**Each later release:** pull or ship the new build, run `db:migrate`, then `db:seed` (new seeds only apply once), and restart the one process. Expect a short outage during the restart; zero-downtime deploys would need a second instance, which realtime does not support yet.

---

## 4. AWS

### 4.1 Recommended shape (closest to the original POC plan)

```text
Internet ──HTTPS──> EC2 (Caddy or nginx -> next start :3000, systemd)
                        │  security group: 443 in; no SSH (use SSM Session Manager)
                        │  EBS volume mounted for employee documents
                        └──5432, TLS──> RDS PostgreSQL 17 (private subnet, single-AZ)
                                        security group: 5432 from the EC2 SG only
```

No load balancer, ECS or EKS. They add cost and do nothing for a single-instance app.

### 4.2 Resources

| Concern | AWS service | Notes |
|---|---|---|
| App host | EC2, small burstable instance (for example `t4g.small` or `t3.small`) | 2 GB RAM is the practical floor for `next build` on the box; with 1 GB, build in CI. `@node-rs/argon2` ships ARM64 and x86-64 binaries, so Graviton works. |
| Database | RDS for PostgreSQL 17, small burstable class, single-AZ, encrypted storage | `btree_gist` is supported and, from PG 13, trusted, so the DB owner can create it. Verify on first migration. |
| Network | VPC, public subnet for EC2, private subnets for RDS | RDS "publicly accessible" = No. |
| TLS | Caddy (automatic Let's Encrypt) or nginx + certbot on the instance | For nginx, set `proxy_buffering off` and `proxy_read_timeout` above 25 s for `/api/realtime/stream`. Caddy streams by default. |
| DNS | Route 53 or existing DNS, plus an Elastic IP | |
| Secrets | SSM Parameter Store (SecureString) or Secrets Manager | Render to a root-only `EnvironmentFile` for the systemd unit at deploy time. Instance role grants read access. |
| Documents | Separate EBS volume (or S3 once an adapter exists) | Back it up with Data Lifecycle Manager snapshots. |
| Access | SSM Session Manager | Needed for `bootstrap:owner` and maintenance; no open port 22. |
| Backups | RDS automated backups (choose retention) + EBS snapshots | Test one restore before go-live. |
| Logs | journald, optionally the CloudWatch agent | Logs are JSON lines and need no parser. |
| Cost | AWS Budgets alert | Free Tier and credit terms change; check eligibility at deploy time. |

### 4.3 Steps

1. Create the VPC, subnets and the two security groups (EC2: 443 from anywhere, optionally 80 for ACME; RDS: 5432 from the EC2 SG).
2. Create RDS PostgreSQL 17 in the private subnet group. Keep the master password in Secrets Manager.
3. Launch EC2 with an instance role (SSM core + read the app's parameters). Attach and mount the documents EBS volume (for example at `/srv/restaurant-ops/hr-files`).
4. Install Node 26 (for example with `nvm` or NodeSource), Caddy or nginx, and git.
5. Connect through Session Manager; create the `restaurant_app` role and the `restaurant_ops` database with the master user; check `btree_gist`.
6. Put the environment variables from section 1 into Parameter Store.
7. Clone the repo at the release commit, then run `npm ci && npm run build`.
8. Write the environment file from Parameter Store, then run `db:migrate`, `db:seed` and `bootstrap:owner`.
9. Create a systemd unit (`npm run start`, `Restart=always`, `EnvironmentFile=`) and the reverse-proxy site; get the certificate.
10. Validate and operate as in section 3.

---

## 5. Azure

Azure has two reasonable shapes. **Option A (VM)** mirrors AWS and is recommended for parity and fewer surprises. **Option B (App Service)** removes OS maintenance but has constraints this app cares about.

### 5.1 Option A: Virtual Machine + PostgreSQL Flexible Server

```text
Internet ──HTTPS──> Azure VM (Caddy or nginx -> next start :3000, systemd)
                        │  NSG: 443 in; no public SSH (use Azure Bastion or just-in-time access)
                        │  managed data disk for employee documents
                        └──5432, TLS──> Azure Database for PostgreSQL Flexible Server 17
                                        private access (VNet integration), no public endpoint
```

| Concern | Azure service | Notes |
|---|---|---|
| App host | Linux VM, small burstable B-series (2 GB RAM or more) | Same build-memory note as AWS. |
| Database | PostgreSQL Flexible Server 17, Burstable tier, private access in a delegated subnet | Check that PG 17 is offered in the chosen region. |
| TLS | Caddy or nginx on the VM | Same SSE proxy settings as AWS. |
| Secrets | Key Vault + VM managed identity | Render to the systemd `EnvironmentFile` at deploy time. |
| Documents | Managed data disk (or Blob Storage once an adapter exists) | Back it up with Azure Backup or disk snapshots. |
| Access | Azure Bastion or just-in-time VM access | Needed for `bootstrap:owner`. |
| Backups | Flexible Server automated backups (choose retention) | Test a point-in-time restore. |
| Logs | journald, optionally Azure Monitor Agent to Log Analytics | |
| Cost | Cost Management budget alert | Check free account and credit terms at deploy time. |

Steps are the same as AWS 4.3, with these swaps:
- VNet and NSG for VPC and security groups;
- Key Vault for Parameter Store;
- Bastion for Session Manager;
- plus the extension allow-listing in 5.3.

### 5.2 Option B: App Service (Linux) + PostgreSQL Flexible Server

It works, with these constraints:
- **One instance only.** Set the plan to one instance and turn off autoscale (see section 1). Turn on **Always On** so the outbox processor isn't idled out.
- **Node 26 support.** Check that App Service offers Node 26 on Linux. If not, deploy a custom container, which needs the `Dockerfile` from section 2 item 5.
- **Streaming.** App Service's front end has a request timeout of roughly 230 s for requests that send nothing. The 25 s SSE heartbeat should keep the stream alive, and the client reconnects anyway. Verify live tickets after deploy.
- **Documents.** Point `EMPLOYEE_DOCUMENT_STORAGE_PATH` under `/home`, which persists across restarts, or use the Blob adapter. Anything outside `/home` is lost on restart.
- **Migrations and owner bootstrap.** These need dev dependencies and an interactive terminal. Run them from a deployment pipeline or jump box with VNet access to the DB, or from the App Service SSH console.
- **Networking.** Use VNet integration to reach the private Flexible Server.
- **Secrets.** Use Key Vault references in App Settings.

### 5.3 `btree_gist` on Azure (required step)

Flexible Server only allows extensions listed in the `azure.extensions` server parameter. **Add `BTREE_GIST` to `azure.extensions` before running `db:migrate`**, or migration `0003` fails. Then confirm with `CREATE EXTENSION IF NOT EXISTS btree_gist;` as the app user. Check the current procedure and privilege rules in Azure's documentation.

---

## 6. Choosing between them

| | AWS (EC2 + RDS) | Azure VM + Flexible Server | Azure App Service + Flexible Server |
|---|---|---|---|
| Matches original plan | Yes | Same shape | Different shape |
| OS patching | You | You | Azure |
| HTTPS certificates | Caddy or certbot on the box | Caddy or certbot on the box | Managed |
| Single-instance realtime | Natural | Natural | Must pin to one instance |
| Extension setup | Usually none (verify) | Allow-list `btree_gist` | Allow-list `btree_gist` |
| Interactive owner bootstrap | Session Manager | Bastion | SSH console or jump box |
| App code changes needed | Section 2 only | Section 2 only | Section 2, maybe a Dockerfile |

Either cloud works without provider-specific business code. Pick the one whose account, credits and operating skills are already in place.

---

## 7. Go-live checklist

- [ ] Section 2 items decided (TLS verification, storage, rate limiting, session cap) and any code changes merged with tests
- [ ] `npm audit --omit=dev` clean; DEV-002 and DEV-003 reviewed
- [ ] Database private, TLS on, app user is not the admin, `btree_gist` present
- [ ] Secrets in the secret store; no `.env` committed or copied to the server; `TEST_DATABASE_URL` unset
- [ ] `APP_BASE_URL` is the public `https://` URL
- [ ] Exactly one app instance; supervisor restarts it on failure
- [ ] Documents path persistent and backed up
- [ ] `db:migrate`, `db:seed` and `bootstrap:owner` done; no demo or validation seed
- [ ] `/api/health` 200; canonical scenario walked on desktop, tablet and phone; live kitchen updates seen
- [ ] DB backups on and one restore tested; logs reachable; budget alert set
