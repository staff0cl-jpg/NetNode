# NETNODE Infrastructure Management

NETNODE is an on-premise network operations application for inventory, discovery, topology visualization, dashboarding, and remote diagnostics in isolated or enterprise environments.

## What NETNODE Currently Does

### Core Modules

- **Dashboard**
  - Infrastructure KPI cards (total, online, active alerts, average load)
  - Trunk throughput/load charts
  - Trunk monitor list
  - Clickable active-alert details modal (device alerts + trunk-down alerts)
  - Customizable dashboard panels with presets and panel settings

- **Inventory**
  - Device registry with branch/city/zone/vendor/model/category/subcategory
  - Region tabs + category tabs (Switches, Routers, FC switches, UPS, All except Other)
  - Sorting for visible columns (including numeric IPv4 and numeric uptime sort)
  - Warnings column uses count-based semantics (number of active warnings per device)
  - Localized warning reasons (RU/EN) in tooltip, including structured reasons (device unreachable, high CPU, down trunk ports)
  - Row actions menu (copy IP, open HTTPS UI, quick device info)
  - Bulk actions and CSV export
  - SNMP template binding + custom OIDs per device

- **Topology**
  - Link graph with saved node layout and role-based edit controls
  - Auto-layout and link rebuild flow
  - Manual link add/delete
  - Quick node actions on double left click (SSH connect / Open Web UI)
  - Manual link creation by right-button drag from one node to another
  - Interactive link label rename directly on map
  - Multi-select rectangle and group move for selected nodes
  - Protection of manual links and manually renamed link labels during rebuild
  - Hierarchy/layout improvements with zone-based grouping
  - Zone normalization/transliteration for stable grouping keys and consistent labels
  - Warning color mapping for node severity (`online`, `warning`, `critical`)
  - Right-click pan on empty canvas area (no mode switch button required)
  - Separate topology views:
    - `L2/L3` (regular IP network devices)
    - `FC` (fibre channel switches)

- **Notifications and UX Feedback**
  - Unified in-app notifications (`success`, `error`, `info`) with auto-dismiss and manual close
  - Notification titles/messages are localized through RU/EN i18n keys
  - Discovery flows (scan/watch) use user-facing localized status toasts for started/running/completed/error states

- **Settings (Branding and Theme)**
  - Product branding controls: product name + PNG logo workflow (upload -> process -> apply)
  - Theme switching (`dark`/`light`) applies immediately in UI and is persisted via system config
  - Public/login surfaces consume applied branding (name/logo/theme) from server configuration

- **Discovery and Monitoring**
  - SNMP-based discovery (no SSH-based autodiscovery in watch flow)
  - LLDP/trunk-aware topology inference and trunk metric collection
  - Discovery watch scheduler with profile intervals and status endpoint
  - Automatic subcategory classification by trunk count:
    - `>= 2`: Core
    - `= 1`: Distribution
    - `= 0`: Access
  - Offline detection in inventory on failed SNMP probe

- **Remote Access and Ops**
  - Browser SSH terminal
  - Legacy SSH algorithm support for old hardware (e.g., HP 1910/1810 compatibility)
  - Audit logging for security-sensitive actions
  - Role-based access (`admin`, `operator`, `viewer`)

### Device/Vendor Coverage (Current Heuristics)

- **Network vendors:** Cisco, MikroTik, HPE/Aruba, Juniper, Huawei, Arista
- **Power vendors:** APC, Eaton, Vertiv, Riello
- **FC support:** FC category detection and separate FC topology mode
- **MikroTik detection:** improved model/vendor identification via `sysObjectId`, `sysDescr`, and `sysName`
- **FC model support:** includes `HP SN3600B` detection path and FC SNMP template

> Detection is heuristic-based and may need tuning per environment, firmware, and MIB exposure.

## Prerequisites

- **Node.js**: `18+`
- **npm**: `9+`
- **PostgreSQL** for durable state (recommended **14+**; schema uses standard `JSONB` / `TIMESTAMPTZ` and is routinely tested with **16** via Docker). Minimum practical target is about **PostgreSQL 12+**.
- **Optional: RabbitMQ** (or any **AMQP 0-9-1** broker) for outbound integration events. If `AMQP_URL` / `RABBITMQ_URL` is unset, the app runs without a broker; publishing is skipped.
- Optional for production:
  - **Nginx** as reverse proxy
  - **pm2** for process management

## Installation paths (two common setups)

There is **one application** (Node.js + the built SPA). What differs is only **how you provide PostgreSQL (and optionally RabbitMQ)**:

| | **A — Traditional (no Docker for dependencies)** | **B — Docker Compose for dependencies** |
|---|--------------------------------------------------|----------------------------------------|
| **PostgreSQL** | Install and operate PostgreSQL on a VM or bare metal (or use a managed DB your team already runs). | Run `docker compose up -d` from this repo: compose starts **PostgreSQL 16** and **RabbitMQ 3** locally (dev defaults `netnode` / `netnode`). |
| **RabbitMQ** | Install separately if you need AMQP events, or omit. | Included in the same compose file; still optional to use from NETNODE. |
| **NETNODE itself** | `npm install` → `npm run dev` or `npm run build` + `npm start` (or pm2/systemd) on the host. Same in both paths. | Same: the **Node process is not defined in `docker-compose.yml`** today—you run it on the host (or you can add your own app container; that is outside the shipped compose). |
| **First connection** | Open the app URL; use the **first-run wizard** if `DATABASE_URL` is unset, or set `DATABASE_URL` in `.env` before start. | After compose is healthy, point the wizard or `.env` at `localhost` (or `host.docker.internal` if the app runs inside another container). |

So: **not two products**—**on-prem / self-hosted always**; Docker Compose is an **optional shortcut** to spin up only the database and broker.

## Runtime persistence and messaging

- **PostgreSQL** stores inventory rows, key-value bundles (system/SNMP/LDAP/backup/topology JSON, users, automation maps, discovery profiles, etc.), and audit log rows. Tables are created automatically on first successful DB connection (`ensureSchema`).
- **Sessions and short-lived caches** (e.g. SNMP trunk sample cache, temporary SSH read-only profile) stay **in process memory** by design.
- **Message broker**: when `AMQP_URL` or `RABBITMQ_URL` is set, the server publishes JSON events to a durable topic exchange `netnode.events` (routing keys such as `inventory.persisted`, `topology.persisted`, `config.persisted`, `audit.*`). No consumer is shipped with NETNODE—you attach your own workers or leave the URL unset.

## First-run setup (web installer)

If **`DATABASE_URL` is not set** in the environment, the UI shows a **first-run setup wizard** instead of the login screen. You provide:

- Site label and product name (branding defaults).
- PostgreSQL host, port, database name, user, and password (you may pre-create an empty database and a user with `CREATE`/`CONNECT` rights on that database).
- Optional AMQP URL for RabbitMQ.
- Local **administrator** username and password (minimum 10 characters).

The wizard:

1. Verifies PostgreSQL connectivity (`POST /api/setup/test-db` optional from UI).
2. Applies schema, seeds default SNMP templates and a default discovery profile, writes `system_config` and the first admin user into `app_kv`, and saves connection settings to **`data/netnode-instance.json`** (see security note below).
3. Sets `process.env.DATABASE_URL` (and AMQP URL if given) for the running process and reloads the DB pool.

After success, the page reloads—sign in with the administrator you created.

**Bypass the wizard** (e.g. automation-only or legacy):

- Set **`DATABASE_URL`** in `.env` or the process environment before start (wizard is skipped), **or**
- Set **`NETNODE_SKIP_SETUP=1`** to force in-memory mode without the wizard (not recommended for production).

**Pre-create PostgreSQL** (typical):

```sql
CREATE DATABASE netnode;
CREATE USER netnode WITH PASSWORD 'your-secret';
GRANT ALL PRIVILEGES ON DATABASE netnode TO netnode;
-- connect to netnode DB, then:
GRANT ALL ON SCHEMA public TO netnode;
```

## Quick stack with Docker (optional)

From the repository root:

```bash
docker compose up -d
```

This starts **PostgreSQL 16** and **RabbitMQ 3** (management UI on port `15672`) with user/password **`netnode` / `netnode`** (development defaults only—change for real deployments).

Example wizard / `.env` connection string:

```text
postgres://netnode:netnode@localhost:5432/netnode
```

Example AMQP URL:

```text
amqp://netnode:netnode@localhost:5672/
```

## Local Development

```bash
npm install
npm run dev
```

If PostgreSQL is not running and `DATABASE_URL` is unset, the dev server still starts and opens the **setup wizard** in the browser.

## Production Build and Run

```bash
npm install
npm run build
npm start
```

With `pm2`:

```bash
pm2 start "npm start" --name netnode
pm2 list
pm2 logs netnode
```

## Environment and deployment notes

- Copy `.env.example` to `.env` and set `PORT` as needed.
- Default service port is `3000`.
- **`DATABASE_URL`**: if set, durable persistence is enabled immediately and the first-run wizard is **not** shown. If unset, use the wizard or add `data/netnode-instance.json` (written by the wizard) so the server can hydrate `DATABASE_URL` on startup.
- **`AMQP_URL` or `RABBITMQ_URL`**: optional; enables publishing to the broker.
- **`NETNODE_SKIP_SETUP=1`**: skip the setup wizard even without `DATABASE_URL` (in-memory mode).
- **`NETNODE_INITIAL_ADMIN_PASSWORD` / `NETNODE_INITIAL_ADMIN_USERNAME`**: optional alternative to the wizard for injecting a first admin when you already provide `DATABASE_URL` via env (see server startup logs).
- The app is designed to run fully on-premise without cloud dependency.
- **`data/netnode-instance.json`** is created by the wizard and contains database (and optional AMQP) credentials. Restrict filesystem permissions on `data/` to the service account (e.g. `chmod 700 data` on Linux). The directory is listed in `.gitignore`; do not commit secrets.

## Nginx Reverse Proxy Example

```nginx
server {
    listen 80;
    server_name netnode.local;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

## Recommended Sizing

| Scale | Devices | CPU | RAM | Storage |
|---|---:|---:|---:|---:|
| Small | <100 | 2 vCPU | 4 GB | 20 GB |
| Medium | 100-500 | 4 vCPU | 8 GB | 100 GB |
| Large | 500-1000+ | 8 vCPU | 16 GB | 250 GB+ |

## Security notes

- After the **first-run wizard**, only the administrator you defined exists—store that password safely. If you used legacy dev defaults (`DATABASE_URL` + non-production Node env), change bundled passwords immediately.
- **`data/netnode-instance.json`** holds PostgreSQL (and optional AMQP) credentials created by the wizard. Restrict directory permissions (`chmod 700 data`), run the service under a dedicated account, and back up this file only to encrypted storage.
- Keep SNMP communities and SSH credentials restricted and rotated.
- Use role-based access and audit logs for operational accountability.

## Known constraints

- Without **PostgreSQL** (or without completing the first-run wizard / `DATABASE_URL`), durable inventory and configuration are **not** persisted across restarts.
- Discovery and metrics accuracy depend on SNMP reachability and device MIB support.
- Some vendor/model mappings are heuristic and can require additional tuning for edge device families.

## Troubleshooting

### First-run wizard and database

- **Wizard never appears but you expected it**  
  - `DATABASE_URL` is already set in the environment (wizard is skipped). Unset it or rely on `data/netnode-instance.json` after the wizard without duplicating `DATABASE_URL` in `.env`.  
  - Or `NETNODE_SKIP_SETUP=1` is set—unset it.

- **`POST /api/setup/test-db` fails**  
  - Confirm host/port reachable from the NETNODE host (`telnet`, `nc`, or `psql`).  
  - Check PostgreSQL `pg_hba.conf` allows the client IP and that authentication (`scram-sha-256`, `md5`, etc.) matches your user.  
  - Verify database name, user, and password; ensure the user may `CONNECT` to the database.  
  - Passwords with special characters are URL-encoded when building the connection string; if connection still fails, try a simpler password to isolate the issue.

- **`POST /api/setup/apply` returns 500 after “saved”**  
  - Schema may be OK but pool reload failed—check server logs, confirm connectivity, restart the process once.

- **After wizard, login fails**  
  - Use the **exact** admin username and password from the wizard (minimum 10 characters).  
  - If you re-ran the wizard against the same database, users KV may have been overwritten—use the latest credentials or a fresh database.

- **`data/` permission errors on Linux**  
  - Ensure the process user can create and write `data/netnode-instance.json` (`mkdir -p data`, `chown` to the service user, `chmod 700 data`).

### PostgreSQL version and schema

- Prefer **PostgreSQL 14+** (the bundled Docker example uses **16**). **12+** is generally compatible; if DDL fails, upgrade the server.

### Message broker (optional)

- **No events in RabbitMQ**  
  - Confirm `AMQP_URL` or `RABBITMQ_URL` is set (wizard or environment) and the broker is reachable from the app host.  
  - Exchange `netnode.events` is declared on first publish; **no queues are created**—bind your own queues in RabbitMQ.

- **AMQP connection errors**  
  - Check vhost, credentials, TLS (`amqps://` vs `amqp://`), and firewall rules to broker port (default `5672`).

### Application and build

- **Node syntax/runtime errors**: verify Node.js `18+`.
- **Build issues after Node upgrade**:
  ```bash
  rm -rf node_modules package-lock.json
  npm install
  npm run build
  ```
- **502 via Nginx**: verify the app responds on `127.0.0.1:PORT` locally, then validate `proxy_pass`, WebSocket headers for Socket.IO, and timeouts (`proxy_read_timeout` / `proxy_send_timeout` for long SSH sessions).
- **`pm2` not found**:
  ```bash
  sudo npm install -g pm2
  ```

### Docker networking

- If NETNODE runs **inside** a container but PostgreSQL on the **host**, use `host.docker.internal` (Docker Desktop) or the host’s bridge/gateway IP—not `localhost` inside the container—unless you use host networking.
