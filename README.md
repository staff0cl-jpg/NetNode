# NETNODE Infrastructure Management

This application is designed for deployment on local servers (Air-Gapped environments) using a Node.js runtime.

## 1. Prerequisites

Before installing, ensure your system has the following components:

- **Node.js**: v18.0 or higher
- **NPM**: v9.0 or higher
- **Nginx**: Used as a reverse proxy
- **Process Manager**: (Optional) `pm2` is recommended for production persistence

## 2. Installation

1. **Extract Source Code**:
   Upload the project files to your server (e.g., `/var/www/netnode`).

2. **Install Dependencies**:
   ```bash
   cd /var/www/netnode
   npm install
   ```

3. **Build the Application**:
   ```bash
   npm run build
   ```

4. **Start the Server**:
   For production, it is recommended to use `pm2`:
   ```bash
   # Start using pm2
   pm2 start server.ts --name netnode --interpreter npx -- tsx
   
   # Or using standard node (if server.ts is compiled or using tsx directly)
   NODE_ENV=production npx tsx server.ts
   ```

## 3. Nginx Configuration

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
