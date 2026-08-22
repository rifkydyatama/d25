#!/bin/bash
# Production Deployment Script for D25 Teknologi Pendidikan
# Usage: ./deploy.sh [production|staging]

set -e

ENV=${1:-production}
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/var/backups/d25"

echo "🚀 Starting deployment for $ENV environment..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as root (for nginx/ssl)
if [[ $EUID -eq 0 ]]; then
    echo -e "${YELLOW}⚠️  Running as root - this is okay for initial setup${NC}"
fi

# Function to check command success
check_success() {
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ $1${NC}"
    else
        echo -e "${RED}✗ $1${NC}"
        exit 1
    fi
}

# 1. Create backup directory
echo "📦 Creating backup directory..."
mkdir -p $BACKUP_DIR
check_success "Backup directory created"

# 2. Backup database (if using local Postgres)
if command -v pg_dump &> /dev/null; then
    echo "💾 Backing up database..."
    pg_dump -h localhost -U postgres d25 > "$BACKUP_DIR/db_backup_$TIMESTAMP.sql" 2>/dev/null || echo "Database backup skipped (remote DB)"
    check_success "Database backup completed"
fi

# 3. Backup application files
echo "📁 Backing up application files..."
tar -czf "$BACKUP_DIR/app_backup_$TIMESTAMP.tar.gz" \
    --exclude=node_modules \
    --exclude=.git \
    --exclude=logs \
    --exclude=uploads \
    --exclude=ssl \
    . 2>/dev/null
check_success "Application backup completed"

# 4. Pull latest code
echo "📥 Pulling latest code..."
git fetch origin
git checkout main
git pull origin main
check_success "Code pulled"

# 5. Install dependencies
echo "📦 Installing dependencies..."
npm ci --only=production
check_success "Dependencies installed"

# 6. Run database migrations
echo "🗄️  Running database migrations..."
if [ -f "database/migrations/001_initial_schema.sql" ]; then
    echo "Running migrations (manual step - run in Supabase SQL Editor)"
    echo "File: database/migrations/001_initial_schema.sql"
else
    echo "No migration files found"
fi

# 7. Build assets (if any)
echo "🔨 Building assets..."
# Add build steps here if using webpack/vite/etc

# 8. Restart application with PM2
echo "🔄 Restarting application..."
if command -v pm2 &> /dev/null; then
    pm2 reload ecosystem.config.js --env production
    check_success "PM2 reload completed"
else
    echo "PM2 not found, starting with node..."
    NODE_ENV=production node server.production.js &
    check_success "Application started"
fi

# 8. Reload Nginx
echo "🔄 Reloading Nginx..."
if systemctl is-active --quiet nginx; then
    nginx -t && systemctl reload nginx
    check_success "Nginx reloaded"
else
    echo "Nginx not running via systemctl (maybe Docker)"
fi

# 9. Verify deployment
echo "🔍 Verifying deployment..."
sleep 5
HEALTH_CHECK=$(curl -s -o /dev/null -w "%{http_code}" https://d25teknopendidikan.com/health || curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health)
if [ "$HEALTH_CHECK" = "200" ]; then
    check_success "Health check passed (HTTP 200)"
else
    echo -e "${RED}✗ Health check failed (HTTP $HEALTH_CHECK)${NC}"
    exit 1
fi

# 10. Clean old backups (keep last 7 days)
echo "🧹 Cleaning old backups..."
find $BACKUP_DIR -name "*.sql" -mtime +7 -delete 2>/dev/null
find $BACKUP_DIR -name "*.tar.gz" -mtime +7 -delete 2>/dev/null
check_success "Old backups cleaned"

echo -e "${GREEN}✅ Deployment completed successfully!${NC}"
echo "🌐 Application: https://d25teknopendidikan.com"
echo "📊 Health: https://d25teknopendidikan.com/health"
echo "📝 Logs: pm2 logs d25-teknopendidikan"