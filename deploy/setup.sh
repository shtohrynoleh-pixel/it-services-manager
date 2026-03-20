#!/bin/bash
# ============================================
# IT Services Manager — AWS EC2 Setup Script
# Run: sudo bash setup.sh
# ============================================

set -e
echo ""
echo "=========================================="
echo "  IT Services Manager — Server Setup"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

step() { echo -e "\n${GREEN}[$1/8]${NC} $2...\n"; }

# --- 1. Update system ---
step 1 "Updating system packages"
dnf update -y -q

# --- 2. Install Node.js ---
step 2 "Installing Node.js 20 and build tools"
dnf install -y nodejs20 npm git -q 2>/dev/null || dnf install -y nodejs npm git -q
dnf groupinstall -y "Development Tools" -q 2>/dev/null || true
dnf install -y python3 -q 2>/dev/null || true

echo "  Node: $(node --version)"
echo "  npm:  $(npm --version)"

# --- 3. Create app directory ---
step 3 "Setting up application directory"
APP_DIR="/opt/itm"
mkdir -p $APP_DIR
chown ec2-user:ec2-user $APP_DIR

# Check if code is already there
if [ ! -f "$APP_DIR/server.js" ]; then
  echo -e "  ${YELLOW}Code not found in $APP_DIR${NC}"
  echo "  Upload your code first, then re-run this script."
  echo ""
  echo "  From your Windows PC, run:"
  echo "    scp -i itm-key.pem itm.zip ec2-user@YOUR-IP:~/"
  echo ""
  echo "  Then on this server:"
  echo "    cd $APP_DIR && unzip ~/itm.zip"
  echo "    sudo bash ~/setup.sh"
  echo ""

  # Check if zip exists in home
  if [ -f "/home/ec2-user/itm.zip" ]; then
    echo "  Found itm.zip! Extracting..."
    cd $APP_DIR
    sudo -u ec2-user unzip -o /home/ec2-user/itm.zip
  else
    echo "  No code found. After uploading, run this script again."
    exit 0
  fi
fi

# --- 4. Install dependencies ---
step 4 "Installing npm dependencies"
cd $APP_DIR
sudo -u ec2-user npm install --production 2>&1 | tail -3

# --- 5. Configure environment ---
step 5 "Configuring environment"
if [ ! -f "$APP_DIR/.env" ]; then
  if [ -f "$APP_DIR/.env.example" ]; then
    cp $APP_DIR/.env.example $APP_DIR/.env
  else
    cat > $APP_DIR/.env <<'ENVFILE'
SESSION_SECRET=itm-prod-change-me-to-random-string
PORT=3000
ENVFILE
  fi
  # Generate random session secret
  SECRET=$(openssl rand -hex 32 2>/dev/null || echo "itm-$(date +%s)-$(head /dev/urandom | tr -dc a-z0-9 | head -c 20)")
  sed -i "s/SESSION_SECRET=.*/SESSION_SECRET=$SECRET/" $APP_DIR/.env
  chown ec2-user:ec2-user $APP_DIR/.env
  chmod 600 $APP_DIR/.env
  echo "  .env created with random session secret"
else
  echo "  .env already exists, keeping it"
fi

# --- 6. Install PM2 and start app ---
step 6 "Installing PM2 and starting application"
npm install -g pm2 2>&1 | tail -1

# Stop existing if running
su - ec2-user -c "cd $APP_DIR && pm2 delete itm 2>/dev/null || true"
su - ec2-user -c "cd $APP_DIR && pm2 start server.js --name itm --max-memory-restart 300M"
su - ec2-user -c "pm2 save"

# Auto-start on reboot
env PATH=$PATH:/usr/bin pm2 startup systemd -u ec2-user --hp /home/ec2-user 2>&1 | tail -1
su - ec2-user -c "pm2 save"

# --- 7. Port redirect (80 → 3000) ---
step 7 "Setting up port redirect (80 → 3000)"
iptables -t nat -D PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 3000 2>/dev/null || true
iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 3000
sh -c "iptables-save > /etc/iptables.rules"

# Restore iptables on reboot
cat > /etc/systemd/system/iptables-restore.service <<'EOF'
[Unit]
Description=Restore iptables rules
Before=network-pre.target

[Service]
Type=oneshot
ExecStart=/sbin/iptables-restore /etc/iptables.rules

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable iptables-restore 2>/dev/null

# --- 8. Setup daily backup ---
step 8 "Setting up daily database backup"
mkdir -p $APP_DIR/backups
chown ec2-user:ec2-user $APP_DIR/backups

# Add cron job for daily backup at 3 AM
CRON_CMD="0 3 * * * cp $APP_DIR/db/app.db $APP_DIR/backups/app.db.\$(date +\%Y\%m\%d) && find $APP_DIR/backups -name 'app.db.*' -mtime +30 -delete"
(crontab -u ec2-user -l 2>/dev/null | grep -v "$APP_DIR/db/app.db" ; echo "$CRON_CMD") | crontab -u ec2-user -

# --- Done! ---
echo ""
echo "=========================================="
echo -e "  ${GREEN}Setup Complete!${NC}"
echo "=========================================="
echo ""

# Get the public IP
PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo "YOUR-IP")

echo "  Your app is running at:"
echo ""
echo -e "    ${GREEN}http://$PUBLIC_IP${NC}"
echo ""
echo "  Login: admin / admin"
echo ""
echo -e "  ${YELLOW}IMPORTANT: Change the admin password immediately!${NC}"
echo "  Go to Settings → Change Admin Password"
echo ""
echo "  Useful commands:"
echo "    pm2 status        — check if app is running"
echo "    pm2 logs itm      — view app logs"
echo "    pm2 restart itm   — restart after updates"
echo ""
echo "=========================================="
echo ""
