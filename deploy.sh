#!/bin/bash
set -e
cd /home/ec2-user/erp

# Pull latest code from GitHub
git pull origin main

# Rebuild frontend
cd client
npm run build
cd ..

# Restart server
pm2 restart erp-server

echo "✅ Deploy done at $(date)"
