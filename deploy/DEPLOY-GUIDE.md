# Deploy IT Services Manager to AWS EC2

## What you'll get
- Your app running at `http://YOUR-IP:3000`
- Auto-restarts if it crashes (PM2)
- Auto-starts on server reboot
- SQLite database stored on the server
- Optional: free HTTPS with your own domain

---

## Step 1: Create an AWS EC2 Instance

1. Go to https://console.aws.amazon.com/ec2
2. Click **Launch Instance**
3. Settings:
   - **Name**: `it-services-manager`
   - **OS**: Amazon Linux 2023 (free tier eligible)
   - **Instance type**: `t2.micro` (free tier) or `t3.small` for production
   - **Key pair**: Click "Create new key pair"
     - Name: `itm-key`
     - Type: RSA
     - Format: `.pem`
     - **SAVE THIS FILE** — you need it to connect
   - **Network settings**: Click "Edit"
     - Allow SSH (port 22) — your IP only
     - Click "Add security group rule":
       - Type: Custom TCP
       - Port: 3000
       - Source: 0.0.0.0/0 (Anywhere)
     - Click "Add security group rule":
       - Type: Custom TCP
       - Port: 80
       - Source: 0.0.0.0/0 (Anywhere)
     - Click "Add security group rule":
       - Type: Custom TCP
       - Port: 443
       - Source: 0.0.0.0/0 (Anywhere)
   - **Storage**: 20 GB gp3
4. Click **Launch Instance**
5. Wait 1-2 minutes for it to start
6. Go to the instance, copy the **Public IPv4 address**

---

## Step 2: Connect to Your Server

### From Windows (PowerShell):
```powershell
ssh -i "C:\path\to\itm-key.pem" ec2-user@YOUR-IP-ADDRESS
```

### If you get a permissions error on the key file:
```powershell
icacls "C:\path\to\itm-key.pem" /inheritance:r /grant:r "$($env:USERNAME):(R)"
```

---

## Step 3: Run the Setup Script

Once connected to the server, run these commands one at a time:

```bash
# Download and run the setup script
curl -O https://raw.githubusercontent.com/YOUR-REPO/main/deploy/setup.sh

# OR if you don't have a repo, just paste the script manually:
nano setup.sh
# (paste the contents of setup.sh, then Ctrl+X, Y, Enter to save)

# Make it executable and run it
chmod +x setup.sh
sudo bash setup.sh
```

**If you don't want to use the script**, do it manually — see Step 3 (Manual) below.

---

## Step 3 (Manual): Set Up the Server Yourself

Run these commands one at a time:

```bash
# Update system
sudo dnf update -y

# Install Node.js 20
sudo dnf install -y nodejs20 npm git

# Install build tools (needed for better-sqlite3)
sudo dnf groupinstall -y "Development Tools"
sudo dnf install -y python3

# Create app directory
sudo mkdir -p /opt/itm
sudo chown ec2-user:ec2-user /opt/itm

# Clone or upload your code (see Step 4)

# Install dependencies
cd /opt/itm
npm install --production

# Create .env file
cp .env.example .env
nano .env
# Set SESSION_SECRET to something random
# Set PORT=3000

# Install PM2 (keeps app running)
sudo npm install -g pm2

# Start the app
pm2 start server.js --name itm
pm2 save
pm2 startup
# Run the command PM2 tells you to run (starts with sudo)

# Redirect port 80 to 3000 (so you can use http://YOUR-IP without :3000)
sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 3000
sudo sh -c "iptables-save > /etc/iptables.rules"
```

---

## Step 4: Upload Your Code to the Server

### Option A: From your Windows PC (easiest)
```powershell
# First, zip your project (exclude node_modules and db)
# In PowerShell, from F:\Projects\:
Compress-Archive -Path "it-services-manager\*" -DestinationPath "itm.zip" -Force

# Upload to server
scp -i "C:\path\to\itm-key.pem" itm.zip ec2-user@YOUR-IP:~/

# Then on the server:
# ssh into server, then:
cd /opt/itm
unzip ~/itm.zip -d /opt/itm/
npm install --production
pm2 restart itm
```

### Option B: Git (if you push to GitHub)
```bash
# On the server:
cd /opt/itm
git clone https://github.com/YOUR-USER/it-services-manager.git .
npm install --production
cp .env.example .env
nano .env  # edit your settings
pm2 start server.js --name itm
```

---

## Step 5: Open Your App

Go to: `http://YOUR-EC2-PUBLIC-IP`

Login: `admin` / `admin`

**IMPORTANT: Change the admin password immediately in Settings!**

---

## Optional: Add a Domain Name + HTTPS

If you want `https://itm.yourdomain.com`:

1. Buy a domain (Namecheap, GoDaddy, etc.) or use one you have
2. In your domain DNS settings, add an **A record**:
   - Name: `itm` (or `@` for root domain)
   - Value: your EC2 public IP
3. On the server, install Caddy (automatic HTTPS):

```bash
# Install Caddy
sudo dnf install -y dnf-plugins-core
sudo dnf copr enable -y @caddy/caddy
sudo dnf install -y caddy

# Configure Caddy
sudo tee /etc/caddy/Caddyfile <<EOF
itm.yourdomain.com {
    reverse_proxy localhost:3000
}
EOF

# Remove the iptables redirect (Caddy handles port 80/443 now)
sudo iptables -t nat -D PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 3000

# Start Caddy
sudo systemctl enable caddy
sudo systemctl start caddy
```

Now visit `https://itm.yourdomain.com` — HTTPS works automatically!

---

## Useful Commands

```bash
# Check if app is running
pm2 status

# View app logs
pm2 logs itm

# Restart after code changes
pm2 restart itm

# Stop the app
pm2 stop itm

# Check server resources
free -h
df -h
```

---

## Updating Your App

```bash
# Upload new code (from Windows)
scp -i "C:\path\to\itm-key.pem" itm.zip ec2-user@YOUR-IP:~/

# On the server
cd /opt/itm
unzip -o ~/itm.zip
npm install --production
pm2 restart itm
```

---

## Backup Your Database

The database is at `/opt/itm/db/app.db`. Back it up regularly:

```bash
# Manual backup
cp /opt/itm/db/app.db /opt/itm/db/app.db.backup.$(date +%Y%m%d)

# Auto daily backup (add to crontab)
crontab -e
# Add this line:
0 3 * * * cp /opt/itm/db/app.db /opt/itm/db/app.db.backup.$(date +\%Y\%m\%d)
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Can't connect to server | Check EC2 security group allows your IP on port 22 |
| App not loading in browser | Check security group allows port 80/3000 from 0.0.0.0/0 |
| `npm install` fails | Run `sudo dnf groupinstall -y "Development Tools"` first |
| App crashes | Run `pm2 logs itm` to see the error |
| Database locked | Run `pm2 restart itm` |
| Forgot admin password | On server: `cd /opt/itm && node -e "const db=require('./db/schema').initDB();const b=require('bcryptjs');db.prepare('UPDATE users SET password=? WHERE username=?').run(b.hashSync('admin',10),'admin')"` |
