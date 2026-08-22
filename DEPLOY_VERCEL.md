# Deploy to Vercel

## Quick Deploy

1. **Push to GitHub**
   ```bash
   git add .
   git commit -m "Ready for Vercel deploy"
   git push origin main
   ```

2. **Import in Vercel**
   - Go to https://vercel.com/new
   - Import your GitHub repository
   - Framework Preset: **Other**
   - Build Command: `npm run vercel-build`
   - Output Directory: `public` (or leave empty)

3. **Add Environment Variables**
   In Vercel Dashboard > Settings > Environment Variables, add:

   | Variable | Value | Environment |
   |----------|-------|-------------|
   | `SUPABASE_URL` | `https://your-project.supabase.co` | Production, Preview, Development |
   | `SUPABASE_ANON_KEY` | `your-anon-key` | Production, Preview, Development |
   | `SUPABASE_SERVICE_ROLE_KEY` | `your-service-role-key` | Production, Preview, Development |
   | `MIDTRANS_SERVER_KEY` | `Mid-server-xxxxx` | Production |
   | `MIDTRANS_CLIENT_KEY` | `Mid-client-xxxxx` | Production, Preview, Development |
   | `MIDTRANS_IS_PRODUCTION` | `true` | Production |
   | `NODE_ENV` | `production` | Production |

4. **Deploy**
   Click Deploy - Vercel will build and deploy automatically.

## Local Development

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.vercel.example .env.local

# Edit .env.local with your credentials
# Then run:
npm run dev
```

## API Endpoints

After deployment, your API will be available at:
- `https://your-app.vercel.app/api/health` - Health check
- `https://your-app.vercel.app/api/products` - Get all products
- `https://your-app.vercel.app/api/products/:id` - Get product by ID
- `https://your-app.vercel.app/api/cart` - Get cart
- `https://your-app.vercel.app/api/cart` (POST) - Add to cart
- `https://your-app.vercel.app/api/cart/update` (POST) - Update cart
- `https://your-app.vercel.app/api/cart/remove` (POST) - Remove from cart
- `https://your-app.vercel.app/api/orders` (POST) - Create order
- `https://your-app.vercel.app/api/orders` (GET) - Get user orders
- `https://your-app.vercel.app/api/payment/midtrans-notification` - Midtrans webhook

## Frontend Integration

Update your frontend to use the Vercel API URLs:

```javascript
const API_BASE = 'https://your-app.vercel.app/api';

// Get products
const response = await fetch(`${API_BASE}/products`);
const { products } = await response.json();

// Add to cart
await fetch(`${API_BASE}/cart`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ productId: 'uuid', quantity: 1 })
});
```

## Database Setup

Before deploying, run the migration in Supabase SQL Editor:

1. Go to Supabase Dashboard > SQL Editor
2. Run the contents of `database/migrations/001_initial_schema.sql`

## Midtrans Webhook

After deployment, update Midtrans Dashboard:
- Callback URL: `https://your-app.vercel.app/api/payment/midtrans-notification`

## Notes

- The API is serverless - each request is a separate function invocation
- Session/cart data is stored in Supabase (not in-memory)
- File uploads not supported (use Supabase Storage instead)
- Max function duration: 30 seconds (configured in vercel.json)