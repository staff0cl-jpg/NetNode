# NETNODE Infrastructure Management v2.4

This application is designed for offline deployment on local servers (Air-Gapped environments).

## 1. Operating System Deployment Guides

### Ubuntu / Debian
```bash
# Update and install dependencies
sudo apt update
sudo apt install -y nginx php-fpm php-ldap php-curl php-mbstring php-xml

# Start services
sudo systemctl enable --now nginx php-fpm
```

### CentOS / RHEL / Fedora (using DNF)
```bash
# Update and install EPEL (for some packages)
sudo dnf install -y epel-release
sudo dnf update -y

# Install Nginx and PHP
sudo dnf install -y nginx php php-fpm php-ldap php-mbstring php-xml php-curl

# Start and enable services
sudo systemctl enable --now nginx
sudo systemctl enable --now php-fpm
```

### CentOS 7 (Archived)
```bash
# Install EPEL
sudo yum install epel-release
sudo yum install nginx php php-fpm php-ldap php-mbstring php-xml php-curl
sudo systemctl enable --now nginx
sudo systemctl enable --now php-fpm
```

## 2. System Sizing Recommendations

Scale your deployment based on the number of managed devices:

| Scale | Devices | CPU | RAM | Storage |
|-------|---------|-----|-----|---------|
| **Small** | < 100 | 2 vCPU | 4 GB | 20 GB |
| **Medium** | 100 - 500 | 4 vCPU | 8 GB | 100 GB |
| **Large** | 500 - 1000+ | 8 vCPU | 16 GB | 250 GB+ |

---

## 3. Operating System Deployment Guides
Place the contents of `dist/` into your web root (e.g. `/var/www/netnode/public`).

Example Nginx host config:
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
        include fastcgi_params;
        # Change path based on PHP version and OS
        fastcgi_pass unix:/var/run/php/php-fpm.sock;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    }
}
```

## 4. Security Notes
- **Local Account:** Default access is `admin` / `admin`. Change this in a production environment via User Management.
- **Offline Mode:** The application is fully self-contained. No external CDN or API calls are made after the build process.
- **Languages:** Supports Russian (default) and English.
