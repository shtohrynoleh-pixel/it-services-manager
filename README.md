# IT Services Manager

A web-based tool for managing IT services provided to trucking companies. Track clients, services, billing, servers, subscriptions, digital assets, and inventory — all from one dashboard.

## Features

- **Multi-company management** — track all your trucking clients
- **Services catalog** — define services with pricing, show publicly
- **Per-company tracking** — contacts, users, servers, subscriptions, digital assets, inventory
- **Service agreements** — assign services to companies with custom pricing
- **Billing** — create invoices, track paid/unpaid status
- **Client portal** — give clients read-only access to their own data
- **Access control** — admin sees everything, clients see only their company
- **Public services page** — showcase your offerings at /public/services

## Quick Start (Local)

```bash
cd it-services-manager
npm install
npm start
```

Open http://localhost:3000

**Default admin login:** admin / admin

## Deploy to AWS EC2

### 1. Launch EC2 instance
- Amazon Linux 2023 or Ubuntu 22.04
- t2.micro (free tier) is enough
- Open ports: 22 (SSH), 80 (HTTP), 443 (HTTPS)

### 2. Install Node.js
```bash
# Amazon Linux
sudo yum install -y nodejs npm

# Ubuntu
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 3. Install build tools (needed for better-sqlite3)
```bash
# Amazon Linux
sudo yum install -y gcc-c++ make python3

# Ubuntu
sudo apt-get install -y build-essential python3
```

### 4. Upload and install
```bash
# From your local machine
scp -r it-services-manager/ ec2-user@YOUR-EC2-IP:~/

# On EC2
cd ~/it-services-manager
npm install
```

### 5. Run with PM2 (keeps it running)
```bash
sudo npm install -g pm2
pm2 start server.js --name itms
pm2 save
pm2 startup  # follow the printed command
```

### 6. Set up Nginx reverse proxy (port 80 → 3000)
```bash
sudo yum install -y nginx  # or apt-get on Ubuntu
```

Create `/etc/nginx/conf.d/itms.conf`:
```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo systemctl start nginx
sudo systemctl enable nginx
```

### 7. Add HTTPS (free SSL with Let's Encrypt)
```bash
sudo yum install -y certbot python3-certbot-nginx  # Amazon Linux
# or
sudo apt install -y certbot python3-certbot-nginx   # Ubuntu

sudo certbot --nginx -d your-domain.com
```

### 8. Set environment variables
```bash
export SESSION_SECRET="your-random-secret-string-here"
export PORT=3000
```

Or create a `.env` file and use `pm2 start server.js --env production`.

## Tech Stack

- **Backend:** Node.js + Express
- **Database:** SQLite (via better-sqlite3)
- **Auth:** bcryptjs + express-session
- **Views:** EJS templates
- **No external database server needed**

## File Structure

```
it-services-manager/
├── server.js          # Main entry point
├── package.json
├── db/
│   └── schema.js      # Database schema + initialization
├── middleware/
│   └── auth.js        # Authentication middleware
├── routes/
│   ├── auth.js        # Login/logout
│   ├── admin.js       # All admin routes + CRUD
│   └── client.js      # Client portal routes
├── views/
│   ├── login.ejs
│   ├── public-services.ejs
│   ├── partials/
│   │   ├── head.ejs
│   │   ├── sidebar.ejs
│   │   └── foot.ejs
│   ├── admin/
│   │   ├── dashboard.ejs
│   │   ├── companies.ejs
│   │   ├── company-detail.ejs
│   │   ├── services.ejs
│   │   ├── billing.ejs
│   │   └── settings.ejs
│   └── client/
│       ├── portal.ejs
│       └── services.ejs
└── public/            # Static files (CSS, images)
```

## Database

SQLite database is stored at `db/app.db`. It's created automatically on first run.

**Backup:** Just copy the `db/app.db` file.

**Tables:** companies, contacts, company_users, servers, subscriptions, assets, inventory, services, agreements, invoices, invoice_items, users, settings
