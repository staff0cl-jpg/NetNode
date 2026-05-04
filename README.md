# NETNODE Infrastructure Management

This application is designed for deployment on local servers (Air-Gapped environments) using a Node.js runtime.

## 1. Prerequisites

Before installing, ensure your system has the following components:

- **Node.js**: **v18.0 or higher** (Required for Vite and modern ESM features)
- **NPM**: v9.0 or higher

> [!CAUTION]
> If you see `SyntaxError: Unexpected reserved word` regarding `await import`, it means your Node.js version is too old. Upgrade to Node.js v18+.
- **Nginx**: Used as a reverse proxy
- **Process Manager**: (Optional) `pm2` is recommended for production persistence

## 2. Installation

1. **Extract Source Code**:
   Upload the project files to your server (e.g., `/var/www/netnode`).

2. **Setup Global Tools**:
   ```bash
   # Install PM2 for process management
   sudo npm install -g pm2
   ```

3. **Install Dependencies**:
   ```bash
   cd /var/www/netnode
   npm install
   ```

4. **Configuration**:
   Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

5. **Build the Application**:
   ```bash
   npm run build
   ```

6. **Start the Server**:
   For production with `pm2`:
   ```bash
   # Using local tsx (installed via npm install)
   pm2 start "npx tsx server.ts" --name netnode
   
   # Or directly with node (if using compiled version, but npx tsx is easiest for TS)
   NODE_ENV=production npx tsx server.ts
   ```

## 3. Cleanup

Files like `metadata.json` are specific to the development environment and can be safely removed or ignored in your production deployment.

## 4. Nginx Configuration

Configure Nginx to proxy traffic to the Node.js application (default port 3000).

Example configuration (`/etc/nginx/sites-available/netnode`):
```nginx
server {
    listen 80;
    server_name netnode.local;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        
        # Increase timeouts for long SSH sessions if needed
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

## 4. System Sizing Recommendations

Scale your deployment based on the number of managed devices:

| Scale | Devices | CPU | RAM | Storage |
|-------|---------|-----|-----|---------|
| **Small** | < 100 | 2 vCPU | 4 GB | 20 GB |
| **Medium** | 100 - 500 | 4 vCPU | 8 GB | 100 GB |
| **Large** | 500 - 1000+ | 8 vCPU | 16 GB | 250 GB+ |

## 5. Security Notes

- **Local Account**: Default access is `admin` / `admin`. Change this immediately via the user management settings.
- **Privacy**: The application is fully self-contained. No external CDN or tracking calls are made.
- **SSH/Terminal**: SSH sessions are handled via a secure tunnel between the server and the managed equipment.
- **Audit Logs**: All sensitive actions are logged and visible to administrators.

## 6. Troubleshooting

**1. SyntaxError: Unexpected reserved word (await import)**
This means your Node.js version is too old (< 18). 
Update Node.js using NodeSource:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**2. dpkg error (trying to overwrite ... libnode-dev)**
If you see a conflict with `libnode-dev` during upgrade:
```bash
sudo apt-get remove -y libnode-dev
sudo apt-get install -f
sudo apt-get install -y nodejs
```

**3. Error: Cannot find native binding (Tailwind/Vite)**
If you see an error about native bindings after upgrading Node.js:
```bash
# Force rebuild of dependencies for the new Node version
rm -rf node_modules package-lock.json
npm install
npm run build
```

**4. Command 'pm2' not found**
Install PM2 globally:
```bash
sudo npm install -g pm2
```
