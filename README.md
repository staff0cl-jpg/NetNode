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
  - Row actions menu (copy IP, open HTTPS UI, quick device info)
  - Bulk actions and CSV export
  - SNMP template binding + custom OIDs per device

- **Topology**
  - Link graph with manual drag and saved node layout
  - Auto-layout and link rebuild flow
  - Manual link add/delete
  - Interactive link label rename directly on map
  - Protection of manual links and manually renamed link labels during rebuild
  - Right-click pan on empty canvas area (no mode switch button required)
  - Separate topology views:
    - `L2/L3` (regular IP network devices)
    - `FC` (fibre channel switches)

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
- Optional for production:
  - **Nginx** as reverse proxy
  - **pm2** for process management

## Local Development

```bash
npm install
npm run dev
```

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

## Environment and Deployment Notes

- Copy `.env.example` to `.env` and set `PORT` as needed.
- Default service port is `3000`.
- The app is designed to run fully on-premise without cloud dependency.

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

## Security Notes

- Change default credentials immediately after first login.
- Keep SNMP communities and SSH credentials restricted and rotated.
- Use role-based access and audit logs for operational accountability.

## Known Constraints

- Data is currently in-memory; restart can reset runtime state if external persistence is not added.
- Discovery/metrics accuracy depends on SNMP reachability and device MIB support.
- Some vendor/model mappings are heuristic and can require additional tuning for edge device families.

## Troubleshooting Quick List

- **Node syntax/runtime errors**: verify Node.js `18+`.
- **Build issues after Node upgrade**:
  ```bash
  rm -rf node_modules package-lock.json
  npm install
  npm run build
  ```
- **502 via Nginx**: verify app is reachable on local port first, then validate proxy target.
- **pm2 not found**:
  ```bash
  sudo npm install -g pm2
  ```
