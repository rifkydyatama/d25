module.exports = {
  apps: [
    {
      name: 'd25-teknopendidikan',
      script: 'server.production.js',
      cwd: '/app',
      instances: 'max',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        APP_URL: 'https://d25teknopendidikan.com'
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        APP_URL: 'https://d25teknopendidikan.com'
      },
      // Logging
      log_file: '/app/logs/combined.log',
      error_file: '/app/logs/error.log',
      out_file: '/app/logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      max_size: '10M',
      retain: 30,
      compress: true,
      
      // Process management
      max_memory_restart: '1G',
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 4000,
      
      // Graceful reload
      kill_timeout: 5000,
      listen_timeout: 30000,
      
      // Monitoring
      pmx: true,
      vizion: false,
      
      // Watch for changes (disable in production)
      watch: false,
      ignore_watch: ['logs', 'node_modules', 'uploads', '.git'],
      
      // Source map support
      source_map_support: true,
      
      // Auto restart on crash
      autorestart: true,
      
      // Cron restart (optional - restart daily at 4 AM)
      // cron_restart: '0 4 * * *'
    }
  ],
  
  // Deploy configuration
  deploy: {
    production: {
      user: 'deploy',
      host: 'your-server-ip',
      ref: 'origin/main',
      repo: 'git@github.com:your-org/d25-teknopendidikan.git',
      path: '/var/www/d25',
      'pre-deploy-local': '',
      'post-deploy': 'npm ci --only=production && pm2 reload ecosystem.config.js --env production',
      'pre-setup': ''
    }
  }
};