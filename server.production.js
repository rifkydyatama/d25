// Production-ready Express Server
require('dotenv').config({ path: process.env.NODE_ENV === 'production' ? '.env.production' : '.env' });

const express = require('express');
const path = require('path');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const { createClient } = require('@supabase/supabase-js');

const { productService, cartService, orderService, settingsService, authService } = require('./lib/db');
const { Midtrans, buildSnapPayload, buildCoreVAPayload } = require('./lib/midtrans');
const emailService = require('./lib/email');
const logger = require('./lib/logger');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Trust proxy for rate limiting behind nginx
app.set('trust proxy', 1);


// =====================================================
// SECURITY MIDDLEWARE
// =====================================================

// Helmet for security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://app.midtrans.com", "https://api.midtrans.com"],
      // Izinkan inline event handler (onclick dll) yang dipakai UI,
      // contoh: tombol kupon checkout onclick="applyCoupon()"
      scriptSrcAttr: ["'unsafe-inline'"],
      connectSrc: ["'self'", "https://api.midtrans.com", "https://app.midtrans.com", "https://*.supabase.co"],
      frameSrc: ["'self'", "https://app.midtrans.com"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: IS_PRODUCTION ? [] : null
    }
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// CORS
app.use(cors({
  origin: IS_PRODUCTION ? process.env.APP_URL : '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: { error: 'Terlalu banyak request, silakan coba lagi nanti' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/payment/') // Skip for webhooks
});
app.use(limiter);

// Stricter rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Terlalu banyak percobaan login, silakan coba lagi 15 menit' }
});

// Compression
app.use(compression());

// Logging
app.use(morgan('combined', {
  stream: { write: (msg) => logger.info(msg.trim()) },
  skip: (req) => req.path === '/health'
}));

// =====================================================
// BODY PARSING
// =====================================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// =====================================================
// STATIC FILES
// =====================================================
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: IS_PRODUCTION ? '1y' : '0',
  etag: true,
  lastModified: true,
  fallthrough: true,
  index: false
}));

// Debug after static files
app.use((req, res, next) => {
  console.log(`[DEBUG after static] ${req.method} ${req.path}`);
  next();
});

// =====================================================
// VIEW ENGINE
// =====================================================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// =====================================================
// SESSION
// =====================================================
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: IS_PRODUCTION,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: IS_PRODUCTION ? 'strict' : 'lax'
  },
  name: 'd25.sid'
}));

// =====================================================
// SUPABASE CLIENTS
// =====================================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = supabaseUrl && supabaseAnonKey 
  ? createClient(supabaseUrl, supabaseAnonKey) 
  : null;

const supabaseAdmin = supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
  : supabase;

// =====================================================
// MIDTRANS
// =====================================================
const midtrans = new Midtrans({
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY,
  isProduction: IS_PRODUCTION
});

// =====================================================
// HELPERS
// =====================================================
function formatRupiah(angka) {
  return 'Rp ' + Number(angka).toLocaleString('id-ID');
}

async function getCartData(req) {
  let cart = [];
  let cartCount = 0;
  let subtotal = 0;
  let tax = 0;
  let total = 0;

  try {
    if (req.session.user?.id) {
      const userCart = await cartService.getOrCreateCart(req.session.user.id, null);
      if (userCart) cart = await cartService.getCartWithItems(userCart.id);
    } else if (req.session.cartSessionId) {
      const guestCart = await cartService.getOrCreateCart(null, req.session.cartSessionId);
      if (guestCart) cart = await cartService.getCartWithItems(guestCart.id);
    }
  } catch (e) {
    logger.error('Cart error', { error: e.message });
  }

  cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  tax = 0;
  total = subtotal;

  return { cart, cartCount, subtotal, tax, total };
}

// =====================================================
// COUPON / DISCOUNT SYSTEM
// =====================================================
const COUPONS = {
  'DISKON10': { type: 'percent', value: 10, minOrder: 0, maxDiscount: 50000, description: 'Diskon 10%', active: true },
  'DISKON20': { type: 'percent', value: 20, minOrder: 100000, maxDiscount: 100000, description: 'Diskon 20% (min. belanja Rp100rb)', active: true },
  'HEMAT50K': { type: 'flat', value: 50000, minOrder: 200000, maxDiscount: 50000, description: 'Potongan Rp50.000 (min. belanja Rp200rb)', active: true },
  'HEMAT25K': { type: 'flat', value: 25000, minOrder: 100000, maxDiscount: 25000, description: 'Potongan Rp25.000 (min. belanja Rp100rb)', active: true },
  'D25PROMO': { type: 'percent', value: 15, minOrder: 50000, maxDiscount: 75000, description: 'Diskon 15% spesial D25 (min. belanja Rp50rb)', active: true },
};

function calculateDiscount(couponCode, subtotal) {
  const code = (couponCode || '').toUpperCase().trim();
  const coupon = COUPONS[code];
  if (!coupon || !coupon.active) return { valid: false, message: 'Kode kupon tidak valid atau sudah tidak berlaku.' };
  if (subtotal < coupon.minOrder) return { valid: false, message: `Minimal belanja ${formatRupiah(coupon.minOrder)} untuk menggunakan kupon ini.` };

  let discount = 0;
  if (coupon.type === 'percent') {
    discount = Math.round(subtotal * (coupon.value / 100));
    if (coupon.maxDiscount && discount > coupon.maxDiscount) discount = coupon.maxDiscount;
  } else {
    discount = coupon.value;
  }

  return { valid: true, discount, description: coupon.description, code };
}

// Coupon validation API
app.post('/api/validate-coupon', async (req, res) => {
  try {
    const { code, subtotal } = req.body;
    const result = calculateDiscount(code, Number(subtotal) || 0);
    res.json(result);
  } catch (e) {
    logger.error('Coupon validation error', { error: e.message });
    res.status(500).json({ valid: false, message: 'Gagal memvalidasi kupon.' });
  }
});

// =====================================================
// GLOBALS FOR VIEWS
// =====================================================
// Test route - BEFORE globals middleware
app.get('/test-early', (req, res) => {
  console.log('[ROUTE HIT EARLY] /test-early');
  res.json({ message: 'Early test route works', timestamp: new Date().toISOString() });
});

app.use((req, res, next) => {
  res.locals.formatRupiah = formatRupiah;
  res.locals.currentUser = req.session.user || null;
  console.log(`[DEBUG] ${req.method} ${req.path}`);
  next();
});

// =====================================================
// HEALTH CHECK
// =====================================================
app.get('/health', async (req, res) => {
  try {
    // Check Supabase connection
    const { error } = await supabaseAdmin.from('products').select('id').limit(1);
    if (error) throw error;
    
    res.json({ 
      status: 'healthy', 
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: process.env.npm_package_version || '1.0.0'
    });
  } catch (e) {
    logger.error('Health check failed', { error: e.message });
    res.status(503).json({ status: 'unhealthy', error: e.message });
  }
});

// Test route
app.get('/test-route', (req, res) => {
  console.log('[ROUTE HIT] /test-route');
  res.json({ message: 'Test route works', timestamp: new Date().toISOString() });
});

// Test route 2
app.get('/ping', (req, res) => {
  console.log('[ROUTE HIT] /ping');
  res.json({ pong: true, timestamp: new Date().toISOString() });
});

// =====================================================
// ROUTES
// =====================================================

// Home
app.get('/', async (req, res) => {
  try {
    const { cartCount } = await getCartData(req);
    const products = await productService.getAll({ limit: 6 });
    res.render('index', { products, cartCount, formatRupiah, currentPage: 'home' });
  } catch (e) {
    logger.error('Home error', { error: e.message });
    const { cartCount } = await getCartData(req);
    res.render('index', { products: [], cartCount, formatRupiah, currentPage: 'home' });
  }
});

// Products listing
app.get('/products', async (req, res) => {
  try {
    const { cartCount } = await getCartData(req);
    const category = req.query.category;
    const products = await productService.getAll({ category });
    const categories = await productService.getCategories();
    res.render('products', { products, categories, currentCategory: category, cartCount, formatRupiah, currentPage: 'products' });
  } catch (e) {
    logger.error('Products error', { error: e.message });
    const { cartCount } = await getCartData(req);
    res.render('products', { products: [], categories: [], cartCount, formatRupiah, currentPage: 'products' });
  }
});

// Product detail
app.get('/product/:id', async (req, res) => {
  try {
    const { cartCount } = await getCartData(req);
    const product = await productService.getById(req.params.id);
    
    if (!product) {
      return res.status(404).render('404', { message: 'Produk tidak ditemukan', cartCount, formatRupiah });
    }
    
    res.render('product-detail', { product, cartCount, formatRupiah, currentPage: 'products' });
  } catch (e) {
    logger.error('Product detail error', { error: e.message, id: req.params.id });
    const { cartCount } = await getCartData(req);
    res.status(404).render('404', { message: 'Produk tidak ditemukan', cartCount, formatRupiah });
  }
});

// Cart
app.get('/cart', async (req, res) => {
  try {
    const { cart, cartCount, subtotal, tax, total } = await getCartData(req);
    res.render('cart', { cart, subtotal, tax, total, cartCount, formatRupiah, currentPage: 'cart' });
  } catch (e) {
    logger.error('Cart error', { error: e.message });
    const { cartCount } = await getCartData(req);
    res.render('cart', { cart: [], subtotal: 0, tax: 0, total: 0, cartCount, formatRupiah, currentPage: 'cart' });
  }
});

// Add to cart
app.post('/add-to-cart/:id', async (req, res) => {
  try {
    const productId = req.params.id;
    const quantity = parseInt(req.body.quantity) || 1;
    
    const product = await productService.getById(productId);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Produk tidak ditemukan' });
    }

    let cartId;
    if (req.session.user?.id) {
      const cart = await cartService.getOrCreateCart(req.session.user.id, null);
      cartId = cart.id;
    } else {
      if (!req.session.cartSessionId) {
        req.session.cartSessionId = require('crypto').randomUUID();
      }
      const cart = await cartService.getOrCreateCart(null, req.session.cartSessionId);
      cartId = cart.id;
    }

    await cartService.addItem(cartId, productId, quantity);
    const { cartCount } = await getCartData(req);
    
    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.json({ success: true, cartCount, message: 'Berhasil ditambahkan ke keranjang' });
    }
    res.redirect('/cart');
  } catch (e) {
    logger.error('Add to cart error', { error: e.message });
    res.status(500).json({ success: false, message: 'Gagal menambahkan ke keranjang' });
  }
});

// Update cart quantity
app.post('/update-cart/:id', async (req, res) => {
  try {
    const productId = req.params.id;
    const quantity = parseInt(req.body.quantity);
    
    if (isNaN(quantity) || quantity < 1) {
      return res.status(400).json({ success: false, message: 'Jumlah tidak valid' });
    }

    let cartId;
    if (req.session.user?.id) {
      const cart = await cartService.getOrCreateCart(req.session.user.id, null);
      cartId = cart?.id;
    } else if (req.session.cartSessionId) {
      const cart = await cartService.getOrCreateCart(null, req.session.cartSessionId);
      cartId = cart?.id;
    }

    if (!cartId) {
      return res.status(404).json({ success: false, message: 'Keranjang tidak ditemukan' });
    }

    await cartService.updateQuantity(cartId, productId, quantity);
    const { cartCount } = await getCartData(req);
    res.json({ success: true, cartCount });
  } catch (e) {
    logger.error('Update cart error', { error: e.message });
    res.status(500).json({ success: false, message: 'Gagal mengupdate keranjang' });
  }
});

// Remove from cart
app.post('/remove-from-cart/:id', async (req, res) => {
  try {
    const productId = req.params.id;
    let cartId;
    
    if (req.session.user?.id) {
      const cart = await cartService.getOrCreateCart(req.session.user.id, null);
      cartId = cart?.id;
    } else if (req.session.cartSessionId) {
      const cart = await cartService.getOrCreateCart(null, req.session.cartSessionId);
      cartId = cart?.id;
    }

    if (!cartId) {
      return res.status(404).json({ success: false, message: 'Keranjang tidak ditemukan' });
    }

    await cartService.removeItem(cartId, productId);
    const { cartCount } = await getCartData(req);
    
    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.json({ success: true, cartCount });
    }
    res.redirect('/cart');
  } catch (e) {
    logger.error('Remove from cart error', { error: e.message });
    res.status(500).json({ success: false, message: 'Gagal menghapus dari keranjang' });
  }
});

// Checkout page
app.get('/checkout', async (req, res) => {
  try {
    const { cart, cartCount, subtotal, tax, total } = await getCartData(req);
    
    if (!cart.length) {
      return res.redirect('/cart');
    }

    const { getPaymentFees } = require('./lib/paymentConfig');
    const { settingsService } = require('./lib/db');
    const [paymentFees, settings] = await Promise.all([
      getPaymentFees(),
      settingsService.getAll().catch(() => ({}))
    ]);

    // Filter to active methods
    const activePaymentFees = Object.fromEntries(
      Object.entries(paymentFees).filter(([, m]) => m.active !== false)
    );

    const poEnabled = settings.po_enabled === '1' || settings.po_enabled === true || settings.po_enabled === 'true';
    
    res.render('checkout', { 
      cart, subtotal, tax: 0, total: subtotal, cartCount, formatRupiah,
      currentPage: 'checkout',
      paymentFees: activePaymentFees,
      poEnabled,
      poSettings: {
        dpPercentage: settings.po_dp_percentage || 50,
        deadlineDays: settings.po_deadline_days || 14,
        description: settings.po_description || ''
      },
      midtransClientKey: process.env.MIDTRANS_CLIENT_KEY,
      midtransIsProduction: !process.env.MIDTRANS_SERVER_KEY?.startsWith('SB-')
    });
  } catch (e) {
    logger.error('Checkout page error', { error: e.message });
    res.redirect('/cart');
  }
});

const { getPaymentFees, calculatePaymentFee } = require('./lib/paymentConfig');

// Process checkout
app.post('/checkout', async (req, res) => {
  try {
    const { name, email, phone, address, institution, notes, payment_method, is_preorder, coupon_code } = req.body;
    
    if (!name || !email || !phone || !address || !payment_method) {
      if (req.accepts('json') || req.xhr) {
        return res.status(400).json({ success: false, message: 'Semua field wajib diisi.' });
      }
      const { cart, cartCount, subtotal } = await getCartData(req);
      const paymentFees = await getPaymentFees();
      return res.render('checkout', { 
        error: 'Semua field wajib diisi.', 
        cart, subtotal, tax: 0, total: subtotal, cartCount, formatRupiah, currentPage: 'checkout',
        paymentFees,
        poEnabled: false, poSettings: {},
        midtransClientKey: process.env.MIDTRANS_CLIENT_KEY,
        midtransIsProduction: !process.env.MIDTRANS_SERVER_KEY?.startsWith('SB-')
      });
    }

    let cartId;
    if (req.session.user?.id) {
      const cart = await cartService.getOrCreateCart(req.session.user.id, null);
      cartId = cart?.id;
    } else if (req.session.cartSessionId) {
      const cart = await cartService.getOrCreateCart(null, req.session.cartSessionId);
      cartId = cart?.id;
    }

    if (!cartId) {
      if (req.accepts('json') || req.xhr) {
        return res.status(400).json({ success: false, message: 'Keranjang kosong' });
      }
      return res.redirect('/cart');
    }

    const allFees = await getPaymentFees();
    const { subtotal } = await getCartData(req);
    const paymentMethodConfig = allFees[payment_method] || null;
    const isPreorder = is_preorder === '1' || is_preorder === 'true';

    let dpPercentage = 50;
    if (isPreorder) {
      const { settingsService } = require('./lib/db');
      const s = await settingsService.getAll().catch(() => ({}));
      dpPercentage = parseInt(s.po_dp_percentage) || 50;
    }

    // Apply coupon discount
    let discountAmount = 0;
    let appliedCoupon = null;
    if (coupon_code) {
      const couponResult = calculateDiscount(coupon_code, subtotal);
      if (couponResult.valid) {
        discountAmount = couponResult.discount;
        appliedCoupon = couponResult.code;
      }
    }

    const effectiveSubtotal = subtotal - discountAmount;
    const dpAmount = isPreorder ? Math.round(effectiveSubtotal * (dpPercentage / 100)) : effectiveSubtotal;
    const paymentFee = calculatePaymentFee(paymentMethodConfig, dpAmount);

    // Append coupon info to notes
    let couponNotes = notes || '';
    if (appliedCoupon && discountAmount > 0) {
      couponNotes = `[KUPON: ${appliedCoupon} - Diskon ${formatRupiah(discountAmount)}] ${couponNotes}`.trim();
    }

    const order = await orderService.createFromCart(cartId, {
      userId: req.session.user?.id,
      name, email, phone, address, institution,
      paymentMethod: payment_method,
      notes: couponNotes, paymentFee, paymentMethodConfig,
      isPreorder, dpPercentage,
      discountAmount
    });

    order.is_preorder = isPreorder;
    order.dp_amount = isPreorder ? Math.round(effectiveSubtotal * (dpPercentage / 100)) : null;
    order.dp_percentage = isPreorder ? dpPercentage : null;
    order.paymentFee = paymentFee;
    order.paymentMethodConfig = paymentMethodConfig;
    order.discountAmount = discountAmount;

    req.session.lastOrder = order;

    // Send order confirmation email
    try {
      await emailService.sendOrderConfirmation({
        ...order,
        customer_name: name,
        customer_email: email,
        items: order.items || order.order_items
      });
      await emailService.sendAdminNewOrder({
        ...order,
        customer_name: name,
        customer_email: email,
        items: order.items || order.order_items
      });
    } catch (emailErr) {
      logger.error('Failed to send order emails', { error: emailErr.message });
    }

    if (paymentMethodConfig && paymentMethodConfig.isPreorder && !paymentMethodConfig.snapType) {
      if (req.accepts('json') || req.xhr) {
        return res.json({ success: true, snapToken: null, orderNumber: order.order_number, isPreorder: true });
      }
      return res.redirect('/order-success?status=preorder&order=' + order.order_number);
    }

    // Create Midtrans Snap transaction (charges DP for PO or Full for Regular)
    try {
      const snapPayload = buildSnapPayload(order);
      const snapResponse = await midtrans.createSnapTransaction(snapPayload);
      
      order.paymentToken = snapResponse.token;
      order.paymentRedirectUrl = snapResponse.redirect_url;

      if (req.accepts('json') || req.xhr) {
        return res.json({ 
          success: true, 
          snapToken: snapResponse.token,
          redirectUrl: snapResponse.redirect_url,
          orderNumber: order.order_number,
          isPreorder
        });
      }
      return res.redirect(snapResponse.redirect_url);
    } catch (midtransError) {
      logger.error('Midtrans create error', { error: midtransError.message, orderId: order.order_number });
      
      // If Midtrans fails, still save order and show success with manual payment info
      if (req.accepts('json') || req.xhr) {
        return res.json({ 
          success: true, 
          snapToken: null,
          orderNumber: order.order_number,
          message: 'Pesanan berhasil dibuat. Silakan hubungi admin untuk informasi pembayaran.'
        });
      }
      
      return res.redirect('/order-success');
    }
  } catch (e) {
    logger.error('Checkout error', { error: e.message });
    if (req.accepts('json') || req.xhr) {
      return res.status(500).json({ success: false, message: 'Gagal memproses pesanan: ' + e.message });
    }
    const { cart, cartCount, subtotal, tax, total } = await getCartData(req);
    res.render('checkout', { 
      error: 'Gagal memproses pesanan: ' + e.message, 
      cart, subtotal, tax, total, cartCount, formatRupiah, currentPage: 'checkout' 
    });
  }
});

// Order success
app.get('/order-success', async (req, res) => {
  try {
    const { cartCount } = await getCartData(req);
    const order = req.session.lastOrder;
    
    if (!order) return res.redirect('/');
    
    delete req.session.lastOrder;
    res.render('order-success', { order, formatRupiah, cartCount });
  } catch (e) {
    logger.error('Order success error', { error: e.message });
    const { cartCount } = await getCartData(req);
    res.render('order-success', { order: null, formatRupiah, cartCount });
  }
});

// Midtrans Notification Handler
app.post('/payment/midtrans-notification', async (req, res) => {
  try {
    logger.info('Midtrans Notification', { body: req.body });
    
    const notification = await midtrans.core.transactions.notification(req.body);
    
    const { 
      order_id,
      transaction_status,
      fraud_status,
      payment_type,
      va_numbers,
      transaction_time,
      gross_amount
    } = notification;
    
    if (!order_id) {
      return res.status(400).json({ status: 'error', message: 'Invalid payload' });
    }
    
    const baseOrderNumber = order_id.replace(/-(?:DP|LUNAS)(?:-\d+)?$/i, '');
    const isSettlement = /-LUNAS(?:-\d+)?$/i.test(order_id);

    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('*')
      .eq('order_number', baseOrderNumber)
      .single();
    
    if (!order) {
      logger.warn('Order not found for notification', { orderId: order_id, base: baseOrderNumber });
      return res.status(404).json({ status: 'error', message: 'Order not found' });
    }
    
    let newStatus = order.status;
    let newPaymentStatus = order.payment_status;
    const isPO = order.is_preorder || (order.notes && order.notes.includes('PRE-ORDER'));
    
    switch (transaction_status) {
      case 'capture':
        if (fraud_status === 'challenge') {
          newStatus = 'processing';
          newPaymentStatus = 'pending';
        } else if (fraud_status === 'accept') {
          if (isSettlement || !isPO) {
            newStatus = 'completed';
            newPaymentStatus = 'paid';
          } else {
            newStatus = 'processing';
            newPaymentStatus = 'dp_paid';
          }
        }
        break;
      case 'settlement':
        if (isSettlement || !isPO) {
          newStatus = 'completed';
          newPaymentStatus = 'paid';
        } else {
          newStatus = 'processing';
          newPaymentStatus = 'dp_paid';
        }
        break;
      case 'pending':
        newStatus = isPO ? 'preorder' : 'processing';
        newPaymentStatus = 'pending';
        break;
      case 'deny':
      case 'cancel':
      case 'expire':
        newStatus = 'cancelled';
        newPaymentStatus = 'failed';
        break;
      default:
        newStatus = 'processing';
        newPaymentStatus = 'pending';
    }
    
    const updates = {
      status: newStatus,
      payment_status: newPaymentStatus,
      payment_type: payment_type,
      payment_details: notification,
      updated_at: new Date().toISOString()
    };
    
    if (newPaymentStatus === 'paid') {
      updates.paid_at = new Date().toISOString();
    }
    if (newStatus === 'completed') {
      updates.completed_at = new Date().toISOString();
    }
    if (va_numbers?.[0]?.va_number) {
      updates.payment_id = va_numbers[0].va_number;
    }
    
    await supabaseAdmin
      .from('orders')
      .update(updates)
      .eq('id', order.id);
    
    logger.info('Order updated from notification', { 
      orderId: order_id, 
      transactionStatus: transaction_status,
      newStatus,
      newPaymentStatus
    });
    
    // Send email based on status
    if (newPaymentStatus === 'paid' && order.payment_status !== 'paid') {
      await emailService.sendPaymentSuccess({
        ...order,
        paid_at: new Date().toISOString()
      });
    } else if (newPaymentStatus === 'failed' && order.payment_status !== 'failed') {
      await emailService.sendPaymentFailed({ ...order }, 'failed');
    }
    
    res.status(200).json({ status: 'success' });
  } catch (e) {
    logger.error('Midtrans Notification error', { error: e.message });
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

// Login
app.get('/login', async (req, res) => {
  const { cartCount } = await getCartData(req);
  res.render('login', { cartCount, formatRupiah, currentPage: 'login' });
});

app.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  const { cartCount } = await getCartData(req);
  
  if (!supabase) {
    if (email === 'admin' && password === 'd25tkp2026') {
      req.session.user = { id: 'admin', email: 'admin', username: 'admin', role: 'admin' };
      return res.redirect('/admin');
    }
    return res.render('login', { error: 'Supabase tidak dikonfigurasi', cartCount, formatRupiah, currentPage: 'login' });
  }

  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    
    if (error) throw error;
    
    if (data.user) {
      const profile = await authService.getProfile(data.user.id);
      req.session.user = { 
        id: data.user.id, 
        email: data.user.email, 
        username: profile?.full_name || data.user.email,
        role: profile?.role || 'student'
      };
      
      if (req.session.cartSessionId) {
        await cartService.mergeCarts(data.user.id, req.session.cartSessionId);
        delete req.session.cartSessionId;
      }
      
      return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/');
    }
    
    res.render('login', { error: 'Login gagal', cartCount, formatRupiah, currentPage: 'login' });
  } catch (e) {
    logger.error('Login error', { error: e.message });
    res.render('login', { error: 'Email atau password salah', cartCount, formatRupiah, currentPage: 'login' });
  }
});

// Register
app.get('/register', async (req, res) => {
  const { cartCount } = await getCartData(req);
  res.render('register', { cartCount, formatRupiah, currentPage: 'register' });
});

app.post('/register', authLimiter, async (req, res) => {
  const { name, email, password, phone, institution } = req.body;
  const { cartCount } = await getCartData(req);
  
  if (!supabase) {
    return res.render('register', { error: 'Supabase tidak dikonfigurasi', cartCount, formatRupiah, currentPage: 'register' });
  }

  try {
    const { data, error } = await supabase.auth.signUp({ 
      email, 
      password,
      options: {
        data: { full_name: name, phone, institution }
      }
    });
    
    if (error) throw error;
    
    if (data.user) {
      req.session.user = { 
        id: data.user.id, 
        email: data.user.email, 
        username: name,
        role: 'student'
      };
      return res.redirect('/');
    }
    
    res.render('register', { error: 'Registrasi gagal', cartCount, formatRupiah, currentPage: 'register' });
  } catch (e) {
    logger.error('Register error', { error: e.message });
    res.render('register', { error: e.message || 'Email sudah terdaftar', cartCount, formatRupiah, currentPage: 'register' });
  }
});

// Logout
app.get('/logout', async (req, res) => {
  if (supabase && req.session.user?.id) {
    await supabase.auth.signOut();
  }
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// =====================================================
// ADMIN ROUTES
// =====================================================
const requireAdmin = (req, res, next) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.redirect('/login');
  }
  next();
};

app.get('/admin', requireAdmin, async (req, res) => {
  try {
    const products = await productService.getAll();
    const stats = await orderService.getStats();
    res.render('admin/dashboard', { products, stats, formatRupiah, cartCount: 0, currentPage: 'admin', user: req.session.user });
  } catch (e) {
    logger.error('Admin dashboard error', { error: e.message });
    res.render('admin/dashboard', { products: [], stats: {}, formatRupiah, cartCount: 0, currentPage: 'admin', user: req.session.user });
  }
});

app.get('/admin/orders', requireAdmin, async (req, res) => {
  try {
    const orders = await orderService.getAll({ limit: 50 });
    res.render('admin/orders', { orders, formatRupiah, cartCount: 0, currentPage: 'admin', user: req.session.user });
  } catch (e) {
    logger.error('Admin orders error', { error: e.message });
    res.render('admin/orders', { orders: [], formatRupiah, cartCount: 0, currentPage: 'admin', user: req.session.user });
  }
});

app.post('/admin/orders/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status, paymentStatus } = req.body;
    await orderService.updateStatus(req.params.id, status, paymentStatus);
    res.json({ success: true });
  } catch (e) {
    logger.error('Update order status error', { error: e.message });
    res.status(500).json({ success: false, message: e.message });
  }
});

// Admin API - Get single order (for detail modal)
app.get('/admin/api/orders/:id', requireAdmin, async (req, res) => {
  try {
    const order = await orderService.getById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
    res.json(order);
  } catch (e) {
    logger.error('Get order detail error', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/products', requireAdmin, async (req, res) => {
  try {
    const products = await productService.getAll();
    res.render('admin/products', { products, formatRupiah, cartCount: 0, currentPage: 'admin', user: req.session.user });
  } catch (e) {
    logger.error('Admin products error', { error: e.message });
    res.render('admin/products', { products: [], formatRupiah, cartCount: 0, currentPage: 'admin', user: req.session.user });
  }
});

app.get('/admin/analytics', requireAdmin, async (req, res) => {
  try {
    const stats = await orderService.getStats();
    const { data: recentOrders } = await supabaseAdmin
      .from('orders')
      .select('created_at, total, payment_status')
      .order('created_at', { ascending: false })
      .limit(30);
    
    const ordersByDate = {};
    (recentOrders || []).forEach(o => {
      const date = new Date(o.created_at).toLocaleDateString('id-ID', { month: 'short', day: 'numeric' });
      if (!ordersByDate[date]) ordersByDate[date] = { orders: 0, revenue: 0 };
      ordersByDate[date].orders++;
      if (o.payment_status === 'paid') ordersByDate[date].revenue += o.total;
    });
    
    const chartData = Object.entries(ordersByDate).map(([date, data]) => ({
      date, orders: data.orders, revenue: data.revenue
    })).reverse();
    
    res.render('admin/analytics', { 
      stats, 
      chartData: JSON.stringify(chartData),
      formatRupiah, 
      cartCount: 0, 
      currentPage: 'admin', 
      user: req.session.user 
    });
  } catch (e) {
    logger.error('Admin analytics error', { error: e.message });
    res.render('admin/analytics', { stats: {}, chartData: '[]', formatRupiah, cartCount: 0, currentPage: 'admin', user: req.session.user });
  }
});

app.get('/admin/settings', requireAdmin, async (req, res) => {
  try {
    const settings = await settingsService.getAll();
    res.render('admin/settings', { settings, formatRupiah, cartCount: 0, currentPage: 'admin', user: req.session.user });
  } catch (e) {
    logger.error('Admin settings error', { error: e.message });
    res.render('admin/settings', { settings: {}, formatRupiah, cartCount: 0, currentPage: 'admin', user: req.session.user });
  }
});

// Admin Settings POST handlers
app.post('/admin/settings', requireAdmin, async (req, res) => {
  try {
    const { site_name, site_description, contact_email, contact_phone, contact_address } = req.body;
    await Promise.all([
      settingsService.set('site_name', site_name, 'Nama situs'),
      settingsService.set('site_description', site_description, 'Deskripsi situs'),
      settingsService.set('contact_email', contact_email, 'Email kontak'),
      settingsService.set('contact_phone', contact_phone, 'Nomor telepon'),
      settingsService.set('contact_address', contact_address, 'Alamat lengkap')
    ]);
    res.redirect('/admin/settings?saved=1');
  } catch (e) {
    logger.error('Save settings error', { error: e.message });
    res.redirect('/admin/settings?error=Gagal menyimpan');
  }
});

app.post('/admin/settings/payment', requireAdmin, async (req, res) => {
  try {
    const { tax_rate, currency, max_cart_quantity } = req.body;
    await Promise.all([
      settingsService.set('tax_rate', parseFloat(tax_rate) / 100, 'Persentase pajak'),
      settingsService.set('currency', currency, 'Mata uang'),
      settingsService.set('max_cart_quantity', max_cart_quantity, 'Maksimal quantity per item')
    ]);
    res.redirect('/admin/settings?saved=1');
  } catch (e) {
    logger.error('Save payment settings error', { error: e.message });
    res.redirect('/admin/settings?error=Gagal menyimpan');
  }
});

app.post('/admin/settings/payment-methods', requireAdmin, async (req, res) => {
  try {
    const methods = Array.isArray(req.body.payment_methods) ? req.body.payment_methods : 
                   (req.body.payment_methods ? [req.body.payment_methods] : []);
    await settingsService.set('payment_methods', methods, 'Metode pembayaran');
    res.redirect('/admin/settings?saved=1');
  } catch (e) {
    logger.error('Save payment methods error', { error: e.message });
    res.redirect('/admin/settings?error=Gagal menyimpan');
  }
});

// Save per-method payment fees from admin panel
app.post('/admin/settings/payment-fees', requireAdmin, async (req, res) => {
  try {
    const { settingsService } = require('./lib/db');
    const { defaultPaymentFees } = require('./lib/paymentConfig');
    
    const updatedFees = {};
    for (const key of Object.keys(defaultPaymentFees)) {
      const method = { ...defaultPaymentFees[key] };
      method.active = req.body[`fee_active_${key}`] === '1';
      method.type = req.body[`fee_type_${key}`] || method.type;
      method.value = parseFloat(req.body[`fee_value_${key}`]) || 0;
      updatedFees[key] = method;
    }
    
    await settingsService.set('payment_fees', JSON.stringify(updatedFees), 'Biaya layanan per metode pembayaran');
    res.redirect('/admin/settings?saved=1');
  } catch (e) {
    logger.error('Save payment fees error', { error: e.message });
    res.redirect('/admin/settings?error=Gagal menyimpan biaya layanan');
  }
});

// Save Pre-Order settings
app.post('/admin/settings/preorder', requireAdmin, async (req, res) => {
  try {
    const { settingsService } = require('./lib/db');
    const { po_enabled, po_dp_percentage, po_deadline_days, po_description } = req.body;
    await Promise.all([
      settingsService.set('po_enabled', po_enabled === '1' ? '1' : '0', 'Mode Pre Order aktif'),
      settingsService.set('po_dp_percentage', po_dp_percentage || '50', 'Persentase DP Pre Order'),
      settingsService.set('po_deadline_days', po_deadline_days || '14', 'Estimasi hari pengerjaan'),
      settingsService.set('po_description', po_description || '', 'Keterangan Pre Order')
    ]);
    res.redirect('/admin/settings?saved=1');
  } catch (e) {
    logger.error('Save preorder settings error', { error: e.message });
    res.redirect('/admin/settings?error=Gagal menyimpan pengaturan PO');
  }
});

// Order Tracking page
app.get('/lacak-pesanan', async (req, res) => {
  try {
    const { cartCount } = await getCartData(req);
    const { settingsService, orderService } = require('./lib/db');
    const { getPaymentFees } = require('./lib/paymentConfig');
    const [settings, paymentFees] = await Promise.all([
      settingsService.getAll().catch(() => ({})),
      getPaymentFees()
    ]);
    
    const poSettings = {
      description: settings.po_description || 'Produk ini merupakan Pre Order. Pembayaran DP dilakukan sekarang, pelunasan setelah produk siap.'
    };
    
    const orderNo = req.query.no?.trim();
    let order = null;
    
    if (orderNo) {
      const orders = await orderService.getAll().catch(() => []);
      order = orders.find(o => o.order_number === orderNo) || null;
    }
    
    res.render('order-tracking', {
      cartCount, formatRupiah, currentPage: 'tracking',
      query: orderNo, order, poSettings,
      paymentFees,
      midtransClientKey: process.env.MIDTRANS_CLIENT_KEY,
      midtransIsProduction: !process.env.MIDTRANS_SERVER_KEY?.startsWith('SB-')
    });
  } catch (e) {
    logger.error('Order tracking error', { error: e.message });
    res.render('order-tracking', { cartCount: 0, formatRupiah, currentPage: 'tracking', query: null, order: null, poSettings: {}, paymentFees: {} });
  }
});

// Settlement Payment API (Pelunasan PO)
app.post('/api/orders/:orderNumber/pelunasan', async (req, res) => {
  try {
    const { orderNumber } = req.params;
    const { payment_method } = req.body;

    const { orderService } = require('./lib/db');
    const { getPaymentFees, calculatePaymentFee } = require('./lib/paymentConfig');

    const orders = await orderService.getAll().catch(() => []);
    const order = orders.find(o => o.order_number === orderNumber.trim());

    if (!order) {
      return res.status(404).json({ success: false, message: 'Pesanan tidak ditemukan' });
    }

    if (order.payment_status === 'paid') {
      return res.status(400).json({ success: false, message: 'Pesanan ini sudah lunas sepenuhnya.' });
    }

    const isPreorder = !!(order.is_preorder || order.isPreorder || (order.notes && /pre[- ]?order/i.test(order.notes)));
    const isDPPaid = order.payment_status === 'dp_paid' || order.status === 'processing' || order.status === 'ready';
    const subtotal = Number(order.subtotal || order.total || 0);
    const total = subtotal;
    const dpAmt = Number(order.dp_amount || Math.round(total * ((order.dp_percentage || 50) / 100)) || 0);
    const remainingAmt = Math.max(total - dpAmt, 0);
    const dueBase = isPreorder ? (isDPPaid ? remainingAmt : dpAmt) : total;

    if (dueBase <= 0) {
      return res.status(400).json({ success: false, message: 'Tidak ada tagihan yang perlu dibayar saat ini.' });
    }

    const allFees = await getPaymentFees();
    const paymentMethodConfig = allFees[payment_method || order.payment_method] || null;
    const paymentFee = calculatePaymentFee(paymentMethodConfig, dueBase);
    const payableAmount = dueBase + paymentFee;
    const grossAmount = payableAmount;

    const settlementOrderId = `${order.order_number}-${isDPPaid ? 'LUNAS' : 'DP'}-${Date.now().toString().slice(-4)}`;

    const snapPayload = {
      transaction_details: {
        order_id: settlementOrderId,
        gross_amount: grossAmount
      },
      customer_details: {
        first_name: (order.customer_name || 'Pelanggan').split(' ')[0],
        last_name: (order.customer_name || '').split(' ').slice(1).join(' '),
        email: order.customer_email,
        phone: order.customer_phone,
        billing_address: { address: order.customer_address },
        shipping_address: { address: order.customer_address }
      },
      item_details: [
        {
          id: isDPPaid ? `LUNAS-${order.order_number}` : `DP-${order.order_number}`,
          price: dueBase,
          quantity: 1,
          name: isDPPaid ? `Pelunasan Sisa PO - ${order.order_number}`.substring(0, 50) : `DP Pre-Order (${order.dp_percentage || 50}%) - ${order.order_number}`.substring(0, 50)
        }
      ],
      callbacks: {
        finish: `http://localhost:3000/lacak-pesanan?no=${order.order_number}&status=settled`,
        error: `http://localhost:3000/lacak-pesanan?no=${order.order_number}&status=failed`,
        pending: `http://localhost:3000/lacak-pesanan?no=${order.order_number}&status=pending`
      }
    };

    if (paymentFee > 0) {
      snapPayload.item_details.push({
        id: 'admin_fee',
        price: paymentFee,
        quantity: 1,
        name: paymentMethodConfig?.name ? `Biaya Layanan (${paymentMethodConfig.name})` : 'Biaya Layanan'
      });
    }

    if (paymentMethodConfig?.snapType) {
      snapPayload.enabled_payments = [paymentMethodConfig.snapType];
    }

    const snapResponse = await midtrans.createSnapTransaction(snapPayload);

    return res.json({
      success: true,
      snapToken: snapResponse.token,
      redirectUrl: snapResponse.redirect_url,
      settlementOrderId,
      dueBase,
      remainingAmount: remainingAmt,
      paymentFee,
      amountDue: payableAmount
    });
  } catch (err) {
    logger.error('Settlement error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Gagal membuat sesi pembayaran pelunasan: ' + err.message });
  }
});

// Admin API - Delete order
app.post('/admin/orders/:id/delete', requireAdmin, async (req, res) => {
  try {
    const { orderService } = require('./lib/db');
    await orderService.delete(req.params.id);
    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.json({ success: true, message: 'Pesanan berhasil dihapus' });
    }
    res.redirect('/admin/orders?deleted=1');
  } catch (e) {
    logger.error('Delete order error', { error: e.message });
    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.status(500).json({ success: false, message: 'Gagal menghapus pesanan: ' + e.message });
    }
    res.redirect('/admin/orders?error=Gagal menghapus pesanan');
  }
});

// Admin Products CRUD
app.post('/admin/products', requireAdmin, async (req, res) => {
  try {
    const product = await productService.create(req.body);
    if (req.xhr || req.headers.accept?.includes('json') || req.is('json')) {
      return res.json({ success: true, product });
    }
    res.redirect('/admin/products');
  } catch (e) {
    logger.error('Create product error', { error: e.message });
    if (req.xhr || req.headers.accept?.includes('json') || req.is('json')) {
      return res.status(500).json({ success: false, message: e.message });
    }
    res.redirect('/admin/products?error=Gagal membuat produk');
  }
});

app.post('/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    const product = await productService.update(req.params.id, req.body);
    if (req.xhr || req.headers.accept?.includes('json') || req.is('json')) {
      return res.json({ success: true, product });
    }
    res.redirect('/admin/products');
  } catch (e) {
    logger.error('Update product error', { error: e.message });
    if (req.xhr || req.headers.accept?.includes('json') || req.is('json')) {
      return res.status(500).json({ success: false, message: e.message });
    }
    res.redirect('/admin/products?error=Gagal update produk');
  }
});

app.post('/admin/products/:id/delete', requireAdmin, async (req, res) => {
  try {
    await productService.delete(req.params.id);
    if (req.xhr || req.headers.accept?.includes('json') || req.is('json')) {
      return res.json({ success: true });
    }
    res.redirect('/admin/products');
  } catch (e) {
    logger.error('Delete product error', { error: e.message });
    if (req.xhr || req.headers.accept?.includes('json') || req.is('json')) {
      return res.status(500).json({ success: false, message: e.message });
    }
    res.redirect('/admin/products?error=Gagal hapus produk');
  }
});

app.get('/admin/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const product = await productService.getById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(product);
  } catch (e) {
    logger.error('Get product API error', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// =====================================================
// PUBLIC API ROUTES (for frontend/AJAX)
// =====================================================

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const { error } = await supabaseAdmin.from('products').select('id').limit(1);
    if (error) throw error;
    return res.json({ 
      status: 'healthy', 
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: '1.0.0'
    });
  } catch (e) {
    return res.status(503).json({ status: 'unhealthy', error: e.message });
  }
});

// Products
app.get('/api/products', async (req, res) => {
  try {
    const category = req.query.category;
    const limit = parseInt(req.query.limit) || undefined;
    const popular = req.query.popular === 'true' ? true : 
                   req.query.popular === 'false' ? false : undefined;
    
    const products = await productService.getAll({ category, limit, popular });
    return res.json({ products });
  } catch (e) {
    logger.error('API products error', { error: e.message });
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const product = await productService.getById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan' });
    return res.json({ product });
  } catch (e) {
    logger.error('API product detail error', { error: e.message });
    return res.status(500).json({ error: e.message });
  }
});

// Cart
app.get('/api/cart', async (req, res) => {
  try {
    const { cart, cartCount, subtotal, tax, total } = await getCartData(req);
    return res.json({ cart, cartCount, subtotal, tax, total, formatRupiah });
  } catch (e) {
    logger.error('API cart error', { error: e.message });
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/cart', async (req, res) => {
  try {
    const productId = req.body.productId;
    const quantity = parseInt(req.body.quantity) || 1;
    
    if (!productId) {
      return res.status(400).json({ error: 'Product ID required' });
    }

    const product = await productService.getById(productId);
    if (!product) {
      return res.status(404).json({ error: 'Produk tidak ditemukan' });
    }

    let cartId;
    const userId = req.headers['x-user-id'] || req.body.userId;
    const sessionId = req.headers['x-session-id'] || req.body.sessionId;

    if (userId) {
      const cart = await cartService.getOrCreateCart(userId, null);
      cartId = cart.id;
    } else {
      const sessionIdFinal = sessionId || require('crypto').randomUUID();
      const cart = await cartService.getOrCreateCart(null, sessionIdFinal);
      cartId = cart.id;
    }

    await cartService.addItem(cartId, productId, quantity);
    const { cartCount } = await getCartData({ 
      headers: { 'x-user-id': userId, 'x-session-id': sessionId } 
    });
    
    return res.json({ success: true, cartCount, sessionId });
  } catch (e) {
    logger.error('API add to cart error', { error: e.message });
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/cart/update', async (req, res) => {
  try {
    const productId = req.body.productId;
    const quantity = parseInt(req.body.quantity);
    
    if (isNaN(quantity) || quantity < 1) {
      return res.status(400).json({ error: 'Invalid quantity' });
    }

    const userId = req.headers['x-user-id'] || req.body.userId;
    const sessionId = req.headers['x-session-id'] || req.body.sessionId;

    let cartId;
    if (userId) {
      const cart = await cartService.getOrCreateCart(userId, null);
      cartId = cart?.id;
    } else if (sessionId) {
      const cart = await cartService.getOrCreateCart(null, sessionId);
      cartId = cart?.id;
    }

    if (!cartId) {
      return res.status(404).json({ error: 'Cart not found' });
    }

    await cartService.updateQuantity(cartId, productId, quantity);
    const { cartCount } = await getCartData({ 
      headers: { 'x-user-id': userId, 'x-session-id': sessionId } 
    });
    
    return res.json({ success: true, cartCount });
  } catch (e) {
    logger.error('API update cart error', { error: e.message });
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/cart/remove', async (req, res) => {
  try {
    const productId = req.body.productId;
    const userId = req.headers['x-user-id'] || req.body.userId;
    const sessionId = req.headers['x-session-id'] || req.body.sessionId;

    let cartId;
    if (userId) {
      const cart = await cartService.getOrCreateCart(userId, null);
      cartId = cart?.id;
    } else if (sessionId) {
      const cart = await cartService.getOrCreateCart(null, sessionId);
      cartId = cart?.id;
    }

    if (!cartId) {
      return res.status(404).json({ error: 'Cart not found' });
    }

    await cartService.removeItem(cartId, productId);
    const { cartCount } = await getCartData({ 
      headers: { 'x-user-id': userId, 'x-session-id': sessionId } 
    });
    
    return res.json({ success: true, cartCount });
  } catch (e) {
    logger.error('API remove from cart error', { error: e.message });
    return res.status(500).json({ error: e.message });
  }
});

// Orders
app.post('/api/orders', async (req, res) => {
  try {
    const { name, email, phone, address, institution, payment_method, notes } = req.body;
    
    if (!name || !email || !phone || !address || !payment_method) {
      return res.status(400).json({ error: 'Semua field wajib diisi' });
    }

    let cartId;
    const userId = req.headers['x-user-id'] || req.body.userId;
    const sessionId = req.headers['x-session-id'] || req.body.sessionId;

    if (userId) {
      const cart = await cartService.getOrCreateCart(userId, null);
      cartId = cart?.id;
    } else if (sessionId) {
      const cart = await cartService.getOrCreateCart(null, sessionId);
      cartId = cart?.id;
    }

    if (!cartId) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    const order = await orderService.createFromCart(cartId, {
      userId,
      name,
      email,
      phone,
      address,
      institution,
      paymentMethod: payment_method,
      notes
    });

    return res.json({ success: true, order });
  } catch (e) {
    logger.error('API create order error', { error: e.message });
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] || req.query.userId;
    const orders = await orderService.getUserOrders(userId);
    return res.json({ orders });
  } catch (e) {
    logger.error('API get orders error', { error: e.message });
    return res.status(500).json({ error: e.message });
  }
});

// Midtrans webhook
app.post('/api/payment/midtrans-notification', async (req, res) => {
  try {
    logger.info('Midtrans Notification', { body: req.body });
    
    const notification = req.body;
    const { order_id, transaction_status, fraud_status, payment_type, va_numbers } = notification;

    if (!order_id) {
      return res.status(400).json({ status: 'error', message: 'Invalid payload' });
    }

    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('*')
      .eq('order_number', order_id)
      .single();

    if (!order) {
      logger.warn('Order not found for notification', { orderId: order_id });
      return res.status(404).json({ status: 'error', message: 'Order not found' });
    }

    let newStatus = order.status;
    let newPaymentStatus = order.payment_status;

    switch (transaction_status) {
      case 'capture':
        if (fraud_status === 'challenge') {
          newStatus = 'processing';
          newPaymentStatus = 'pending';
        } else if (fraud_status === 'accept') {
          newStatus = 'completed';
          newPaymentStatus = 'paid';
        }
        break;
      case 'settlement':
        newStatus = 'completed';
        newPaymentStatus = 'paid';
        break;
      case 'pending':
        newStatus = 'processing';
        newPaymentStatus = 'pending';
        break;
      case 'deny':
      case 'cancel':
      case 'expire':
        newStatus = 'cancelled';
        newPaymentStatus = 'failed';
        break;
    }

    const updates = {
      status: newStatus,
      payment_status: newPaymentStatus,
      payment_type: payment_type,
      payment_details: notification,
      updated_at: new Date().toISOString()
    };

    if (newPaymentStatus === 'paid') {
      updates.paid_at = new Date().toISOString();
    }
    if (newStatus === 'completed') {
      updates.completed_at = new Date().toISOString();
    }
    if (va_numbers?.[0]?.va_number) {
      updates.payment_id = va_numbers[0].va_number;
    }

    await supabaseAdmin
      .from('orders')
      .update(updates)
      .eq('id', order.id);

    logger.info('Order updated from notification', { 
      orderId: order_id, 
      transactionStatus: transaction_status,
      newStatus,
      newPaymentStatus
    });

    return res.status(200).json({ status: 'success' });
  } catch (e) {
    logger.error('Midtrans Notification error', { error: e.message });
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

// =====================================================
// 404 & ERROR HANDLERS
// =====================================================
app.use(async (req, res) => {
  const { cartCount } = await getCartData(req);
  res.status(404).render('404', { message: 'Halaman tidak ditemukan', cartCount, formatRupiah });
});

app.use((err, req, res, next) => {
  logger.error('Unhandled error', { 
    error: err.message, 
    stack: err.stack,
    path: req.path,
    method: req.method,
    ip: req.ip
  });
  
  if (IS_PRODUCTION) {
    res.status(500).render('500', { message: 'Terjadi kesalahan server' });
  } else {
    res.status(500).send(err.stack);
  }
});

// =====================================================
// START SERVER
// =====================================================
const server = app.listen(PORT, () => {
  logger.info(`Server started`, { 
    port: PORT, 
    env: process.env.NODE_ENV,
    url: process.env.APP_URL || `http://localhost:${PORT}`
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

module.exports = app;