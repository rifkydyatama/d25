require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const helmet = require('helmet');
const { productService, cartService, orderService, settingsService, authService } = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase config (env vars only, fast)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Custom fetch with timeout
const fetchWithTimeout = (url, options = {}) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
  return fetch(url, {
    ...options,
    signal: controller.signal
  }).finally(() => clearTimeout(timeoutId));
};

// Lazy Supabase clients
let _supabase = null;
let _supabaseAdmin = null;

function getSupabase() {
  if (!_supabase && supabaseUrl && supabaseAnonKey) {
    const { createClient } = require('@supabase/supabase-js');
    _supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { fetch: fetchWithTimeout }
    });
  }
  return _supabase;
}

function getSupabaseAdmin() {
  if (!_supabaseAdmin && supabaseUrl && supabaseServiceKey) {
    const { createClient } = require('@supabase/supabase-js');
    _supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: fetchWithTimeout }
    });
  }
  return _supabaseAdmin || getSupabase();
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://app.midtrans.com",
        "https://app.sandbox.midtrans.com",
        "https://snap-assets.midtrans.com",
        "https://api.midtrans.com",
        "https://pay.google.com",
        "https://gwk.gopayapi.com",
        "https://www.googletagmanager.com",
        "https://cdn.jsdelivr.net"
      ],
      // Izinkan inline event handler (onclick dll) yang dipakai UI,
      // contoh: tombol kupon checkout onclick="applyCoupon()"
      scriptSrcAttr: ["'unsafe-inline'"],
      connectSrc: ["'self'", "https://app.midtrans.com", "https://api.midtrans.com", "https://*.supabase.co"],
      frameSrc: ["'self'", "https://app.midtrans.com", "https://app.sandbox.midtrans.com"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: null
    }
  }
}));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// Trust proxy for production (behind Nginx/Vercel)
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'd25-kelas-offering-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 86400000,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
    httpOnly: true
  }
}));

// Make Supabase client available to views
app.use((req, res, next) => {
  res.locals.supabaseUrl = supabaseUrl;
  res.locals.supabaseAnonKey = supabaseAnonKey;
  res.locals.baseUrl = process.env.BASE_URL || process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  next();
});

function formatRupiah(angka) {
  if (!angka && angka !== 0) return 'Rp 0';
  return 'Rp ' + Number(angka).toLocaleString('id-ID');
}

// Utility function to add timeout to promises
function timeoutPromise(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
  ]);
}

async function getSizePricingConfig() {
  try {
    const { settingsService } = require('./lib/db');
    const raw = await settingsService.get('size_price_config');
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    const defaults = { S: 0, M: 0, L: 0, XL: 0, XXL: 25000, XXXL: 50000 };
    return { ...defaults, ...(parsed || {}) };
  } catch (e) {
    return { S: 0, M: 0, L: 0, XL: 0, XXL: 25000, XXXL: 50000 };
  }
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
      if (userCart) {
        cart = await cartService.getCartWithItems(userCart.id);
      }
    } else if (req.session.cartSessionId) {
      const guestCart = await cartService.getOrCreateCart(null, req.session.cartSessionId);
      if (guestCart) {
        cart = await cartService.getCartWithItems(guestCart.id);
      }
    } else if (req.session.cart) {
      // Fallback to session cart for backward compatibility
      cart = req.session.cart;
    }
  } catch (e) {
    console.error('Cart error:', e);
    cart = req.session.cart || [];
  }

  cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  tax = 0;
  total = subtotal;

  return { cart, cartCount, subtotal, tax, total };
}

// =====================================================
// ROUTES
// =====================================================

app.get('/api/health', async (req, res) => {
  try {
    const { data, error } = await timeoutPromise(
      getSupabaseAdmin().from('products').select('id').limit(1),
      8000
    );
    if (error) throw error;
    return res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: '1.0.0',
      database: !!data
    });
  } catch (e) {
    console.error('Health check failed:', e);
    return res.status(503).json({ status: 'unhealthy', error: e.message || 'Database unavailable' });
  }
});

// Home
app.get('/', async (req, res) => {
  try {
    const { cartCount } = await getCartData(req);
    const products = await productService.getAll({ limit: 6 });
    res.render('index', { products, cartCount, formatRupiah, currentPage: 'home' });
  } catch (e) {
    console.error(e);
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
    console.error(e);
    const { cartCount } = await getCartData(req);
    res.render('products', { products: [], categories: [], cartCount, formatRupiah, currentPage: 'products' });
  }
});

// Product detail
app.get('/product/:id', async (req, res) => {
  try {
    const { cartCount } = await getCartData(req);
    const product = await productService.getById(req.params.id);
    const sizePricing = await getSizePricingConfig();

    if (!product) {
      return res.status(404).render('404', { message: 'Produk tidak ditemukan', cartCount, formatRupiah });
    }

    res.render('product-detail', { product, cartCount, formatRupiah, currentPage: 'products', sizePricing });
  } catch (e) {
    console.error(e);
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
    console.error(e);
    const { cartCount } = await getCartData(req);
    res.render('cart', { cart: [], subtotal: 0, tax: 0, total: 0, cartCount, formatRupiah, currentPage: 'cart' });
  }
});

// Add to cart
app.post('/add-to-cart/:id', async (req, res) => {
  try {
    const productId = req.params.id;
    const quantity = parseInt(req.body.quantity) || 1;
    const rawSize = typeof req.body.size === 'string' ? req.body.size.trim() : req.body.size;
    const selectedSize = rawSize ? rawSize.toUpperCase() : null;
    const sizePricing = await getSizePricingConfig();
    const sizePrice = selectedSize ? Number(sizePricing[selectedSize] || 0) : 0;

    // Verify product exists
    const product = await productService.getById(productId);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Produk tidak ditemukan' });
    }

    let cartId;

    if (req.session.user?.id) {
      const cart = await cartService.getOrCreateCart(req.session.user.id, null);
      cartId = cart.id;
    } else {
      // Generate session ID for guest
      if (!req.session.cartSessionId) {
        req.session.cartSessionId = require('crypto').randomUUID();
      }
      const cart = await cartService.getOrCreateCart(null, req.session.cartSessionId);
      cartId = cart.id;
    }

    await cartService.addItem(cartId, productId, quantity, selectedSize, sizePrice);

    const { cartCount } = await getCartData(req);

    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.json({ success: true, cartCount, message: 'Berhasil ditambahkan ke keranjang' });
    }

    res.redirect('/cart');
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Gagal menambahkan ke keranjang' });
  }
});

// Update cart quantity
app.post('/update-cart/:id', async (req, res) => {
  try {
    const productId = req.params.id;
    const quantity = parseInt(req.body.quantity);
    const requestedSize = typeof req.body.size === 'string' ? req.body.size.trim() || null : (req.body.size || null);

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

    await cartService.updateQuantity(cartId, productId, quantity, requestedSize);

    const { cartCount } = await getCartData(req);
    res.json({ success: true, cartCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Gagal mengupdate keranjang' });
  }
});

// Remove from cart
app.post('/remove-from-cart/:id', async (req, res) => {
  try {
    const productId = req.params.id;
    const requestedSize = typeof req.query.size === 'string' ? req.query.size.trim() || null : (req.body?.size || null);
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

    await cartService.removeItem(cartId, productId, requestedSize);

    const { cartCount } = await getCartData(req);

    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.json({ success: true, cartCount });
    }

    res.redirect('/cart');
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Gagal menghapus dari keranjang' });
  }
});

// =====================================================
// COUPON / DISCOUNT SYSTEM
// =====================================================
const DEFAULT_COUPONS = {
  'DISKON10': { type: 'percent', value: 10, minOrder: 0, maxDiscount: 50000, description: 'Diskon 10%', active: true },
  'DISKON20': { type: 'percent', value: 20, minOrder: 100000, maxDiscount: 100000, description: 'Diskon 20% (min. belanja Rp100rb)', active: true },
  'HEMAT50K': { type: 'flat', value: 50000, minOrder: 200000, maxDiscount: 50000, description: 'Potongan Rp50.000 (min. belanja Rp200rb)', active: true },
  'HEMAT25K': { type: 'flat', value: 25000, minOrder: 100000, maxDiscount: 25000, description: 'Potongan Rp25.000 (min. belanja Rp100rb)', active: true },
  'D25PROMO': { type: 'percent', value: 15, minOrder: 50000, maxDiscount: 75000, description: 'Diskon 15% spesial D25 (min. belanja Rp50rb)', active: true },
};

async function getCouponsFromDB() {
  try {
    const { settingsService } = require('./lib/db');
    const raw = await settingsService.get('coupons');
    if (raw) {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return { ...DEFAULT_COUPONS, ...parsed };
    }
  } catch (e) {
    // fallback to defaults
  }
  return { ...DEFAULT_COUPONS };
}

async function incrementCouponUsage(code) {
  try {
    const { settingsService } = require('./lib/db');
    const coupons = await getCouponsFromDB();
    const upperCode = code.toUpperCase().trim();
    if (coupons[upperCode]) {
      coupons[upperCode].usedCount = (coupons[upperCode].usedCount || 0) + 1;
      await settingsService.set('coupons', JSON.stringify(coupons), 'Daftar kupon diskon');
    }
  } catch (e) {
    console.error('Failed to increment coupon usage:', e);
  }
}

function calculateDiscount(couponCode, subtotal, coupons, userId = null) {
  const code = (couponCode || '').toUpperCase().trim();
  const coupon = (coupons || {})[code];
  if (!coupon || !coupon.active) return { valid: false, message: 'Kode kupon tidak valid atau sudah tidak berlaku.' };

  // Check expiration
  if (coupon.validUntil) {
    const expiry = new Date(coupon.validUntil);
    if (isNaN(expiry.getTime()) || expiry < new Date()) {
      return { valid: false, message: 'Kupon sudah kadaluarsa.' };
    }
  }

  // Check max total uses
  if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) {
    return { valid: false, message: 'Kupon sudah mencapai batas penggunaan maksimal.' };
  }

  // Check max uses per user
  if (userId && coupon.maxUsesPerUser) {
    // Would need to check order history for this user + coupon
    // For now just track in session or skip if not implemented
  }

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
    const coupons = await getCouponsFromDB();
    const result = calculateDiscount(code, Number(subtotal) || 0, coupons);
    res.json(result);
  } catch (e) {
    res.status(500).json({ valid: false, message: 'Gagal memvalidasi kupon.' });
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

    console.log('[DEBUG CHECKOUT] settings:', JSON.stringify(settings, null, 2));
    console.log('[DEBUG CHECKOUT] po_enabled raw:', settings.po_enabled, 'type:', typeof settings.po_enabled);

    // Filter to only active methods
    const activePaymentFees = Object.fromEntries(
      Object.entries(paymentFees).filter(([, m]) => m.active !== false)
    );

    const poEnabled = settings.po_enabled === '1' || settings.po_enabled === true || settings.po_enabled === 'true';
    console.log('[DEBUG CHECKOUT] poEnabled:', poEnabled);

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
    console.error(e);
    res.redirect('/cart');
  }
});

const { Midtrans, buildSnapPayload, buildCoreVAPayload } = require('./lib/midtrans');

// Initialize Midtrans (auto-detects production from key prefix)
const midtrans = new Midtrans({
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY
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

    // Get live payment fees from DB
    const allFees = await getPaymentFees();
    const { subtotal } = await getCartData(req);
    const paymentMethodConfig = allFees[payment_method] || null;
    const isPreorder = is_preorder === '1' || is_preorder === 'true';

    // Apply coupon discount
    let discountAmount = 0;
    let appliedCoupon = null;
    if (coupon_code) {
      const coupons = await getCouponsFromDB();
      const couponResult = calculateDiscount(coupon_code, subtotal, coupons, req.session.user?.id || null);
      if (couponResult.valid) {
        discountAmount = couponResult.discount;
        appliedCoupon = couponResult.code;
      }
    }

    // Get PO settings if preorder
    let dpPercentage = 50;
    if (isPreorder) {
      const { settingsService } = require('./lib/db');
      const s = await settingsService.getAll().catch(() => ({}));
      dpPercentage = parseInt(s.po_dp_percentage) || 50;
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

    // Increment coupon usage count
    if (appliedCoupon) {
      await incrementCouponUsage(appliedCoupon);
    }

    // Ensure PO and fee fields are attached to order in memory for Snap payload builder
    order.is_preorder = isPreorder;
    order.dp_amount = isPreorder ? Math.round(effectiveSubtotal * (dpPercentage / 100)) : null;
    order.dp_percentage = isPreorder ? dpPercentage : null;
    order.paymentFee = paymentFee;
    order.paymentMethodConfig = paymentMethodConfig;
    order.discountAmount = discountAmount;

    // Create Midtrans Snap transaction (charges DP amount for Pre-Order, or Full amount for regular)
    try {
      const snapPayload = buildSnapPayload(order);
      const snapResponse = await timeoutPromise(midtrans.createSnapTransaction(snapPayload), 10000);

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
      req.session.lastOrder = order;
      return res.redirect(snapResponse.redirect_url);

    } catch (midtransError) {
      console.error('Midtrans create error:', midtransError);

      // If Midtrans fails, still save order and show success with manual payment info
      req.session.lastOrder = order;

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
    console.error('Checkout error:', e);
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
    let order = req.session.lastOrder;

    if (!order && req.query.order) {
      const { orderService } = require('./lib/db');
      const orders = await orderService.getAll().catch(() => []);
      order = orders.find(o => o.order_number === req.query.order.trim()) || null;
    }

    if (!order) return res.redirect('/');

    delete req.session.lastOrder;
    res.render('order-success', { order, formatRupiah, cartCount, status: req.query.status || 'success' });
  } catch (e) {
    console.error(e);
    const { cartCount } = await getCartData(req);
    res.render('order-success', { order: null, formatRupiah, cartCount, status: 'error' });
  }
});

// Midtrans Notification Handler (Webhook)
app.post('/payment/midtrans-notification', async (req, res) => {
  try {
    console.log('Midtrans Notification received:', req.body);

    const notification = await timeoutPromise(midtrans.core.transactions.notification(req.body), 10000);

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

    // Find order (handle settlement suffixes like -DP-1234 or -LUNAS-1234)
    const baseOrderNumber = order_id.replace(/-(?:DP|LUNAS)(?:-\d+)?$/i, '');
    const isSettlement = /-LUNAS(?:-\d+)?$/i.test(order_id);

    const adminDb = getSupabaseAdmin();

    const { data: order } = await adminDb
      .from('orders')
      .select('*')
      .eq('order_number', baseOrderNumber)
      .single();

    if (!order) {
      console.log('Order not found for notification:', order_id, 'base:', baseOrderNumber);
      return res.status(404).json({ status: 'error', message: 'Order not found' });
    }

    // Determine new status based on Midtrans status
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
            // Initial DP paid
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
          // Initial DP paid
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

    // Update order
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

    await adminDb
      .from('orders')
      .update(updates)
      .eq('id', order.id);

    console.log(`Order ${order_id} updated: ${transaction_status} -> ${newStatus} / ${newPaymentStatus}`);

    res.status(200).json({ status: 'success' });
  } catch (e) {
    console.error('Midtrans Notification error:', e);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

// Login
app.get('/login', async (req, res) => {
  const { cartCount } = await getCartData(req);
  res.render('login', { cartCount, formatRupiah, currentPage: 'login' });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const { cartCount } = await getCartData(req);

  // Hardcoded admin login - always available
  if (email === 'admin' && password === 'd25tkp2026') {
    req.session.user = { id: 'admin', email: 'admin', username: 'admin', role: 'admin' };
    return res.redirect('/admin');
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.render('login', { error: 'Supabase tidak dikonfigurasi. Gunakan admin/d25tkp2026', cartCount, formatRupiah, currentPage: 'login' });
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

      // Merge guest cart to user cart
      if (req.session.cartSessionId) {
        await cartService.mergeCarts(data.user.id, req.session.cartSessionId);
        delete req.session.cartSessionId;
      }

      return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/');
    }

    res.render('login', { error: 'Login gagal', cartCount, formatRupiah, currentPage: 'login' });
  } catch (e) {
    console.error('Login error:', e);
    const msg = e.message || 'Login gagal';
    res.render('login', { error: msg.includes('fetch') ? 'Gagal koneksi ke Supabase. Cek internet & kredensial .env' : 'Email atau password salah', cartCount, formatRupiah, currentPage: 'login' });
  }
});

// Register
app.get('/register', async (req, res) => {
  const { cartCount } = await getCartData(req);
  res.render('register', { cartCount, formatRupiah, currentPage: 'register' });
});

app.post('/register', async (req, res) => {
  const { name, email, password, phone, institution } = req.body;
  const { cartCount } = await getCartData(req);

  const supabase = getSupabase();
  if (!supabase) {
    return res.render('register', { error: 'Supabase tidak dikonfigurasi', cartCount, formatRupiah, currentPage: 'register' });
  }

  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: name,
          phone,
          institution
        }
      }
    });

    if (error) throw error;

    if (data.user) {
      // Profile created automatically by database trigger
      // Get the profile to set role
      const profile = await authService.getProfile(data.user.id);
      req.session.user = {
        id: data.user.id,
        email: data.user.email,
        username: name,
        role: profile?.role || 'student'
      };

      return res.redirect('/');
    }

    res.render('register', { error: 'Registrasi gagal', cartCount, formatRupiah, currentPage: 'register' });
  } catch (e) {
    console.error('Register error:', e);
    const msg = e.message || 'Registrasi gagal';
    res.render('register', { error: msg.includes('fetch') ? 'Gagal koneksi ke Supabase. Cek internet & kredensial .env' : msg, cartCount, formatRupiah, currentPage: 'register' });
  }
});

// Logout
app.get('/logout', async (req, res) => {
  const supabase = getSupabase();
  if (supabase && req.session.user?.id) {
    await supabase.auth.signOut();
  }
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// Admin routes
app.get('/admin', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.redirect('/login');
  }

  try {
    const products = await productService.getAll();
    const stats = await orderService.getStats();
    res.render('admin/dashboard', { products, stats, formatRupiah, cartCount: 0, currentPage: 'admin', user: req.session.user });
  } catch (e) {
    console.error(e);
    res.render('admin/dashboard', { products: [], stats: {}, formatRupiah, cartCount: 0, currentPage: 'admin', user: req.session.user });
  }
});

// Admin orders
app.get('/admin/orders', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.redirect('/login');
  }

  try {
    const orders = await orderService.getAll({ limit: 50 });
    res.render('admin/orders', { orders, formatRupiah, cartCount: 0, currentPage: 'admin', user: req.session.user });
  } catch (e) {
    console.error(e);
    res.render('admin/orders', { orders: [], formatRupiah, cartCount: 0, currentPage: 'admin', user: req.session.user });
  }
});

// Admin update order status
app.post('/admin/orders/:id/status', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const { status, paymentStatus } = req.body;
    await orderService.updateStatus(req.params.id, status, paymentStatus);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// Admin API - Get single order (for detail modal)
app.get('/admin/api/orders/:id', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const order = await orderService.getById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
    }
    res.json(order);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Admin API - Delete order
app.post('/admin/orders/:id/delete', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    return res.redirect('/login');
  }

  try {
    await orderService.delete(req.params.id);
    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.json({ success: true, message: 'Pesanan berhasil dihapus' });
    }
    res.redirect('/admin/orders?deleted=1');
  } catch (e) {
    console.error('Delete order error:', e);
    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.status(500).json({ success: false, message: 'Gagal menghapus pesanan: ' + e.message });
    }
    res.redirect('/admin/orders?error=Gagal menghapus pesanan');
  }
});


// Admin Analytics
app.get('/admin/analytics', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.redirect('/login');
  }

  try {
    const stats = await orderService.getStats();
    // Get recent orders for charts
    const adminDb = getSupabaseAdmin();

    const { data: recentOrders } = await adminDb
      .from('orders')
      .select('created_at, total, payment_status')
      .order('created_at', { ascending: false })
      .limit(30);

    // Group by date for chart
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
    console.error(e);
    res.render('admin/analytics', {
      stats: {},
      chartData: '[]',
      formatRupiah,
      cartCount: 0,
      currentPage: 'admin',
      user: req.session.user
    });
  }
});

// Admin Settings
app.get('/admin/settings', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.redirect('/login');
  }

  try {
    const { settingsService } = require('./lib/db');
    const { getPaymentFees } = require('./lib/paymentConfig');
    const [settings, paymentFees, rawCoupons] = await Promise.all([
      settingsService.getAll(),
      getPaymentFees(),
      settingsService.get('coupons').catch(() => null)
    ]);
    const sizePricing = settings.size_price_config ? (typeof settings.size_price_config === 'string' ? JSON.parse(settings.size_price_config) : settings.size_price_config) : { S: 0, M: 0, L: 0, XL: 0, XXL: 25000, XXXL: 50000 };
    const coupons = rawCoupons ? (typeof rawCoupons === 'string' ? JSON.parse(rawCoupons) : rawCoupons) : {};
    res.render('admin/settings', {
      settings, paymentFees, sizePricing, coupons,
      query: req.query,
      formatRupiah, cartCount: 0, currentPage: 'admin', user: req.session.user
    });
  } catch (e) {
    console.error(e);
    res.render('admin/settings', {
      settings: {}, paymentFees: {}, sizePricing: { S: 0, M: 0, L: 0, XL: 0, XXL: 25000, XXXL: 50000 }, coupons: {},
      query: req.query,
      formatRupiah, cartCount: 0, currentPage: 'admin', user: req.session.user
    });
  }
});

// Admin Settings - POST handlers
app.post('/admin/settings', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).redirect('/login');
  }

  try {
    const { settingsService } = require('./lib/db');
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
    console.error(e);
    res.redirect('/admin/settings?error=Gagal menyimpan pengaturan');
  }
});

app.post('/admin/settings/payment', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).redirect('/login');
  }

  try {
    const { settingsService } = require('./lib/db');
    const { tax_rate, currency, max_cart_quantity } = req.body;

    await Promise.all([
      settingsService.set('tax_rate', parseFloat(tax_rate) / 100, 'Persentase pajak'),
      settingsService.set('currency', currency, 'Mata uang'),
      settingsService.set('max_cart_quantity', max_cart_quantity, 'Maksimal quantity per item')
    ]);

    res.redirect('/admin/settings?saved=1');
  } catch (e) {
    console.error(e);
    res.redirect('/admin/settings?error=Gagal menyimpan pengaturan pembayaran');
  }
});

app.post('/admin/settings/payment-methods', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).redirect('/login');
  }

  try {
    const { settingsService } = require('./lib/db');
    const methods = Array.isArray(req.body.payment_methods) ? req.body.payment_methods :
      (req.body.payment_methods ? [req.body.payment_methods] : []);

    await settingsService.set('payment_methods', methods, 'Metode pembayaran yang tersedia');
    res.redirect('/admin/settings?saved=1');
  } catch (e) {
    console.error(e);
    res.redirect('/admin/settings?error=Gagal menyimpan metode pembayaran');
  }
});

app.post('/admin/settings/size-pricing', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).redirect('/login');
  }

  try {
    const { settingsService } = require('./lib/db');
    const sizePricing = {
      S: Number(req.body.size_s || 0) || 0,
      M: Number(req.body.size_m || 0) || 0,
      L: Number(req.body.size_l || 0) || 0,
      XL: Number(req.body.size_xl || 0) || 0,
      XXL: Number(req.body.size_xxl || 0) || 0,
      XXXL: Number(req.body.size_xxxl || 0) || 0
    };

    await settingsService.set('size_price_config', sizePricing, 'Biaya tambahan per ukuran');
    res.redirect('/admin/settings?saved=1');
  } catch (e) {
    console.error(e);
    res.redirect('/admin/settings?error=Gagal menyimpan harga ukuran');
  }
});

app.post('/admin/settings/email', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).redirect('/login');
  }

  try {
    const { settingsService } = require('./lib/db');
    const { email_host, email_port, email_user, email_pass, email_from } = req.body;

    await Promise.all([
      settingsService.set('email_host', email_host, 'SMTP Host'),
      settingsService.set('email_port', email_port, 'SMTP Port'),
      settingsService.set('email_user', email_user, 'Email pengirim'),
      settingsService.set('email_pass', email_pass, 'App password'),
      settingsService.set('email_from', email_from, 'Nama pengirim')
    ]);

    res.redirect('/admin/settings?saved=1');
  } catch (e) {
    console.error(e);
    res.redirect('/admin/settings?error=Gagal menyimpan konfigurasi email');
  }
});

// Save per-method payment fees from admin panel
app.post('/admin/settings/payment-fees', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).redirect('/login');
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
    console.error(e);
    res.redirect('/admin/settings?error=Gagal menyimpan biaya layanan');
  }
});

// Save Pre-Order settings
app.post('/admin/settings/preorder', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).redirect('/login');
  try {
    const { settingsService } = require('./lib/db');
    const { po_enabled, po_dp_percentage, po_deadline_days, po_description } = req.body;
    console.log('[DEBUG PREORDER SAVE] req.body:', req.body);
    console.log('[DEBUG PREORDER SAVE] po_enabled:', po_enabled, 'type:', typeof po_enabled);
    await Promise.all([
      settingsService.set('po_enabled', po_enabled === '1' ? '1' : '0', 'Mode Pre Order aktif'),
      settingsService.set('po_dp_percentage', po_dp_percentage || '50', 'Persentase DP Pre Order'),
      settingsService.set('po_deadline_days', po_deadline_days || '14', 'Estimasi hari pengerjaan'),
      settingsService.set('po_description', po_description || '', 'Keterangan Pre Order')
    ]);
    res.redirect('/admin/settings?saved=1');
  } catch (e) {
    console.error(e);
    res.redirect('/admin/settings?error=Gagal menyimpan pengaturan PO');
  }
});

// Coupon settings - Save existing coupons
app.post('/admin/settings/coupons', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).redirect('/login');
  try {
    const { settingsService } = require('./lib/db');
    const coupons = {};
    for (const key of Object.keys(req.body)) {
      if (key.startsWith('coupon_code_')) {
        const codeKey = key.replace('coupon_code_', '');
        const code = req.body[key];
        coupons[code] = {
          type: req.body[`coupon_type_${codeKey}`] || 'percent',
          value: parseFloat(req.body[`coupon_value_${codeKey}`]) || 0,
          minOrder: parseFloat(req.body[`coupon_min_${codeKey}`]) || 0,
          maxDiscount: parseFloat(req.body[`coupon_max_${codeKey}`]) || 0,
          validUntil: req.body[`coupon_valid_${codeKey}`] || null,
          maxUses: parseInt(req.body[`coupon_maxuses_${codeKey}`]) || 0,
          maxUsesPerUser: parseInt(req.body[`coupon_maxuser_${codeKey}`]) || 0,
          usedCount: parseInt(req.body[`coupon_used_${codeKey}`]) || 0,
          description: req.body[`coupon_desc_${codeKey}`] || '',
          active: req.body[`coupon_active_${codeKey}`] === '1'
        };
      }
    }
    await settingsService.set('coupons', JSON.stringify(coupons), 'Daftar kupon diskon');
    res.redirect('/admin/settings?saved=1');
  } catch (e) {
    console.error(e);
    res.redirect('/admin/settings?error=Gagal menyimpan kupon');
  }
});

// Coupon settings - Add new coupon
app.post('/admin/settings/coupons/add', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).redirect('/login');
  try {
    const { settingsService } = require('./lib/db');
    const { code, type, value, minOrder, maxDiscount, validUntil, maxUses, maxUsesPerUser, description, active } = req.body;
    if (!code || !type || !value) {
      return res.redirect('/admin/settings?error=Kode, tipe, dan nilai kupon wajib diisi');
    }

    // Get existing coupons
    const raw = await settingsService.get('coupons');
    const existing = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};

    const upperCode = code.toUpperCase().trim();
    existing[upperCode] = {
      type,
      value: parseFloat(value),
      minOrder: parseFloat(minOrder) || 0,
      maxDiscount: parseFloat(maxDiscount) || 0,
      validUntil: validUntil || null,
      maxUses: parseInt(maxUses) || 0,
      maxUsesPerUser: parseInt(maxUsesPerUser) || 0,
      usedCount: 0,
      description: description || '',
      active: active === '1'
    };

    await settingsService.set('coupons', JSON.stringify(existing), 'Daftar kupon diskon');
    res.redirect('/admin/settings?saved=1');
  } catch (e) {
    console.error(e);
    res.redirect('/admin/settings?error=Gagal menambah kupon: ' + e.message);
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
    console.error(e);
    res.render('order-tracking', { cartCount: 0, formatRupiah, currentPage: 'tracking', query: null, order: null, poSettings: {}, paymentFees: {} });
  }
});

// Settlement Payment API (Pelunasan PO)
app.post('/api/orders/:orderNumber/pelunasan', async (req, res) => {
  try {
    const { orderNumber } = req.params;
    const { payment_method } = req.body;

    const { orderService, db } = require('./lib/db');
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
    // Gunakan TOTAL (setelah diskon kupon), bukan subtotal
    const total = Number(order.total || order.subtotal || 0);
    const dpPct = Number(order.dp_percentage || 50);
    const storedDp = Number(order.dp_amount || 0);
    const expectedDp = Math.round(total * (dpPct / 100));
    // dp_amount tersimpan mungkin dihitung dari subtotal (sebelum diskon) oleh versi lama;
    // hitung ulang dari total jika nilainya tidak konsisten
    const dpAmt = (storedDp > 0 && Math.abs(storedDp - expectedDp) <= 1) ? storedDp : expectedDp;
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

    // Use production base URL when available so Midtrans redirects don't point to localhost
    const baseUrl = process.env.BASE_URL || process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

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
        finish: `${baseUrl}/lacak-pesanan?no=${order.order_number}&status=settled`,
        error: `${baseUrl}/lacak-pesanan?no=${order.order_number}&status=failed`,
        pending: `${baseUrl}/lacak-pesanan?no=${order.order_number}&status=pending`
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

    const snapResponse = await timeoutPromise(midtrans.createSnapTransaction(snapPayload), 10000);

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
    console.error('Settlement error:', err);
    return res.status(500).json({ success: false, message: 'Gagal membuat sesi pembayaran pelunasan: ' + err.message });
  }
});



app.get('/admin/products', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.redirect('/login');
  }

  try {
    const products = await productService.getAll();
    res.render('admin/products', { products, formatRupiah, cartCount: 0, currentPage: 'admin', user: req.session.user });
  } catch (e) {
    console.error(e);
    res.render('admin/products', { products: [], formatRupiah, cartCount: 0, currentPage: 'admin', user: req.session.user });
  }
});

// Admin create product
app.post('/admin/products', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    if (req.xhr || req.headers.accept?.includes('json') || req.is('json')) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    return res.status(403).redirect('/login');
  }

  try {
    const product = await productService.create(req.body);
    if (req.xhr || req.headers.accept?.includes('json') || req.is('json')) {
      return res.json({ success: true, product });
    }
    res.redirect('/admin/products');
  } catch (e) {
    console.error(e);
    if (req.xhr || req.headers.accept?.includes('json') || req.is('json')) {
      return res.status(500).json({ success: false, message: e.message });
    }
    res.redirect('/admin/products?error=Gagal membuat produk');
  }
});

// Admin update product
app.post('/admin/products/:id', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    if (req.xhr || req.headers.accept?.includes('json') || req.is('json')) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    return res.status(403).redirect('/login');
  }

  try {
    const product = await productService.update(req.params.id, req.body);
    if (req.xhr || req.headers.accept?.includes('json') || req.is('json')) {
      return res.json({ success: true, product });
    }
    res.redirect('/admin/products');
  } catch (e) {
    console.error(e);
    if (req.xhr || req.headers.accept?.includes('json') || req.is('json')) {
      return res.status(500).json({ success: false, message: e.message });
    }
    res.redirect('/admin/products?error=Gagal update produk');
  }
});

// Admin delete product
app.post('/admin/products/:id/delete', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    if (req.xhr || req.headers.accept?.includes('json') || req.is('json')) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    return res.status(403).redirect('/login');
  }

  try {
    await productService.delete(req.params.id);
    if (req.xhr || req.headers.accept?.includes('json') || req.is('json')) {
      return res.json({ success: true });
    }
    res.redirect('/admin/products');
  } catch (e) {
    console.error(e);
    if (req.xhr || req.headers.accept?.includes('json') || req.is('json')) {
      return res.status(500).json({ success: false, message: e.message });
    }
    res.redirect('/admin/products?error=Gagal hapus produk');
  }
});

// Admin API - Get single product (for edit modal)
app.get('/admin/api/products/:id', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const product = await productService.getById(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(product);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// 404 handler
app.use(async (req, res) => {
  const { cartCount } = await getCartData(req);
  res.status(404).render('404', { message: 'Halaman tidak ditemukan', cartCount, formatRupiah });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Terjadi kesalahan server');
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
    if (!supabaseUrl || !supabaseAnonKey) {
      console.warn('⚠️  Supabase belum dikonfigurasi! Silakan edit file .env');
    }
  });
}

module.exports = app;