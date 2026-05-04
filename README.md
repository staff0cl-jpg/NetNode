# NETNODE Infrastructure Management v2.4

This application is designed for offline deployment on local servers (Air-Gapped environments).

## Local Deployment Requirements
- **Web Server:** Nginx or Apache
- **Backend:** PHP 7.4+ or 8.x (for LDAP integration)
- **Node.js:** v18+ (only for building the frontend)

## 1. Build the Frontend
To build the application for production, run:
```bash
npm install
npm run build
```
This will generate a `dist/` folder containing all static assets (HTML, JS, CSS, Icons). These files are self-contained and do **not** require internet access.

## 2. Nginx Configuration
Place the contents of `dist/` into your web root (e.g., `/var/www/netnode/public`).

Example Nginx config:
```nginx
server {
    listen 80;
    server_name netnode.local;
    root /var/www/netnode/public;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # If using PHP for LDAP (optional backend)
    location ~ \.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/var/run/php/php8.1-fpm.sock;
    }
}
```

## 3. Offline Assets
The application uses:
- **Tailwind CSS:** Bundled at build time.
- **Lucide Icons:** Bundled as SVG components.
- **Charts (Recharts):** Bundled JS.
- **Topology (Konva):** Bundled JS.
- **Terminal (Xterm):** Bundled JS.

**Fonts:** The system defaults to standard system fonts (San Francisco, Segoe UI, Roboto) if Inter/JetBrains Mono are not found. To ensure specific branding offline, you can copy `.ttf` files into `public/fonts/` and update `index.css`.

## 4. No External Dependencies
Once built, the application makes **zero** requests to external CDNs or AI Studio APIs. ALL logic runs in the browser or via your local PHP/LDAP backend.
