// Database Service Layer - Supabase Integration
const { getSupabaseAdmin } = require('./supabase');

// Lazy getDb() getter
function getDb() {
  return getSupabaseAdmin();
}

// Timeout wrapper for database queries
function timeoutPromise(promise, ms = 8000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Database query timeout')), ms))
  ]);
}

// =====================================================
// PRODUCTS SERVICE
// =====================================================
const productService = {
  // Map Supabase snake_case to camelCase for templates
  mapProduct(p) {
    if (!p) return null;
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      category: p.category,
      price: p.price,
      originalPrice: p.original_price,
      description: p.description,
      instructor: p.instructor,
      duration: p.duration,
      level: p.level,
      image: p.image_url,
      imageUrl: p.image_url,
      popular: p.popular,
      active: p.active,
      metadata: p.metadata,
      createdAt: p.created_at,
      updatedAt: p.updated_at
    };
  },

  // Get all active products
  async getAll(filters = {}) {
    let query = getDb()
      .from('products')
      .select('*')
      .eq('active', true)
      .order('created_at', { ascending: false });

    if (filters.category) {
      query = query.eq('category', filters.category);
    }
    if (filters.popular !== undefined) {
      query = query.eq('popular', filters.popular);
    }
    if (filters.limit) {
      query = query.limit(filters.limit);
    }

    const { data, error } = await timeoutPromise(query);
    if (error) throw error;
    return (data || []).map(this.mapProduct);
  },

  // Get product by ID
  async getById(id) {
    const { data, error } = await timeoutPromise(
      getDb()
        .from('products')
        .select('*')
        .eq('id', id)
        .eq('active', true)
        .single()
    );
    
    if (error && error.code !== 'PGRST116') throw error;
    return this.mapProduct(data);
  },

  // Get product by slug
  async getBySlug(slug) {
    const { data, error } = await timeoutPromise(
      getDb()
        .from('products')
        .select('*')
        .eq('slug', slug)
        .eq('active', true)
        .single()
    );
    
    if (error && error.code !== 'PGRST116') throw error;
    return this.mapProduct(data);
  },

  // Create product (admin)
  async create(productData) {
    const insertData = {
      name: productData.name,
      slug: productData.slug || productData.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
      category: productData.category,
      price: parseInt(productData.price) || 0,
      original_price: parseInt(productData.originalPrice) || 0,
      description: productData.description,
      instructor: productData.instructor,
      duration: productData.duration,
      level: productData.level,
      image_url: productData.imageUrl || productData.image,
      popular: productData.popular === true || productData.popular === 'true',
      active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    const { data, error } = await getDb()
      .from('products')
      .insert([insertData])
      .select()
      .single();
    
    if (error) throw error;
    return this.mapProduct(data);
  },

  // Update product (admin)
  async update(id, updates) {
    const updateData = {};
    if (updates.name) updateData.name = updates.name;
    if (updates.slug) updateData.slug = updates.slug;
    if (updates.category) updateData.category = updates.category;
    if (updates.price !== undefined) updateData.price = parseInt(updates.price) || 0;
    if (updates.originalPrice !== undefined) updateData.original_price = parseInt(updates.originalPrice) || 0;
    if (updates.description) updateData.description = updates.description;
    if (updates.instructor) updateData.instructor = updates.instructor;
    if (updates.duration) updateData.duration = updates.duration;
    if (updates.level) updateData.level = updates.level;
    if (updates.removeImage === true || updates.removeImage === 'true') {
      // Foto dihapus secara eksplisit dari form admin
      updateData.image_url = null;
    } else if (updates.imageUrl || updates.image) {
      updateData.image_url = updates.imageUrl || updates.image;
    }
    if (updates.popular !== undefined) updateData.popular = updates.popular === true || updates.popular === 'true';
    updateData.updated_at = new Date().toISOString();
    
    const { data, error } = await getDb()
      .from('products')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    return this.mapProduct(data);
  },

  // Delete product (admin) - soft delete
  async delete(id) {
    const { error } = await getDb()
      .from('products')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('id', id);
    
    if (error) throw error;
    return true;
  },

  // Get categories
  async getCategories() {
    const { data, error } = await timeoutPromise(
      getDb()
        .from('categories')
        .select('*')
        .eq('active', true)
        .order('sort_order')
    );
    
    if (error) throw error;
    return data || [];
  }
};

// =====================================================
// CART SERVICE
// =====================================================
const cartService = {
  // Map cart item with product details
  mapCartItem(item) {
    if (!item) return null;
    const p = item.products;
    const sizePrice = Number(item.size_price || 0);
    const unitPrice = Number(p.price || 0) + sizePrice;
    return {
      id: p.id,
      name: p.name,
      category: p.category,
      price: unitPrice,
      basePrice: Number(p.price || 0),
      sizePrice,
      originalPrice: p.original_price,
      image: p.image_url,
      imageUrl: p.image_url,
      popular: p.popular,
      instructor: p.instructor,
      duration: p.duration,
      level: p.level,
      quantity: item.quantity,
      size: item.size || null,
      cartItemId: item.id
    };
  },

  // Get or create cart for user/session
  async getOrCreateCart(userId, sessionId) {
    let cart;
    
    if (userId) {
      const { data: existingCart } = await timeoutPromise(
        getDb()
          .from('carts')
          .select('*')
          .eq('user_id', userId)
          .single()
      );
      
      if (existingCart) {
        cart = existingCart;
      } else {
        const { data: newCart, error } = await timeoutPromise(
          getDb()
            .from('carts')
            .insert([{ user_id: userId }])
            .select()
            .single()
        );
        if (error) throw error;
        cart = newCart;
      }
    } else if (sessionId) {
      const { data: existingCart } = await timeoutPromise(
        getDb()
          .from('carts')
          .select('*')
          .eq('session_id', sessionId)
          .is('user_id', null)
          .single()
      );
      
      if (existingCart) {
        cart = existingCart;
      } else {
        const { data: newCart, error } = await timeoutPromise(
          getDb()
            .from('carts')
            .insert([{ session_id: sessionId }])
            .select()
            .single()
        );
        if (error) throw error;
        cart = newCart;
      }
    }
    
    return cart;
  },

  // Get cart with items
  async getCartWithItems(cartId) {
    const { data, error } = await timeoutPromise(
      getDb()
        .from('cart_items')
        .select(`
          *,
          products (
            id, name, category, price, original_price, 
            image_url, popular, instructor, duration, level
          )
        `)
        .eq('cart_id', cartId)
    );
    
    if (error) throw error;
    
    return (data || []).map(item => this.mapCartItem(item));
  },

  // Add item to cart
  async addItem(cartId, productId, quantity = 1, size = null, sizePrice = 0) {
    const normalizedSize = typeof size === 'string' ? size.trim() || null : size || null;
    const normalizedSizePrice = Number(sizePrice) || 0;

    let matchingQuery = getDb()
      .from('cart_items')
      .select('*')
      .eq('cart_id', cartId)
      .eq('product_id', productId);

    if (normalizedSize) {
      matchingQuery = matchingQuery.eq('size', normalizedSize);
    } else {
      matchingQuery = matchingQuery.is('size', null);
    }

    const { data: existing } = await timeoutPromise(matchingQuery.maybeSingle());

    if (existing) {
      const newQuantity = Math.min(existing.quantity + quantity, 10);
      const { data, error } = await timeoutPromise(
        getDb()
          .from('cart_items')
          .update({ quantity: newQuantity, size_price: normalizedSizePrice, updated_at: new Date().toISOString() })
          .eq('id', existing.id)
          .select()
          .single()
      );
      if (error) throw error;
      return data;
    } else {
      const insertPayload = { cart_id: cartId, product_id: productId, quantity, size_price: normalizedSizePrice };
      if (normalizedSize) insertPayload.size = normalizedSize;

      const { data, error } = await timeoutPromise(
        getDb()
          .from('cart_items')
          .insert([insertPayload])
          .select()
          .single()
      );
      if (error) throw error;
      return data;
    }
  },

  // Update item quantity
  async updateQuantity(cartId, productId, quantity, size = null) {
    const normalizedSize = typeof size === 'string' ? size.trim() || null : size || null;
    let query = getDb()
      .from('cart_items')
      .update({ quantity: Math.min(Math.max(quantity, 1), 10), updated_at: new Date().toISOString() })
      .eq('cart_id', cartId)
      .eq('product_id', productId);

    if (normalizedSize) {
      query = query.eq('size', normalizedSize);
    } else {
      query = query.is('size', null);
    }

    const { data, error } = await timeoutPromise(query.select().single());
    
    if (error) throw error;
    return data;
  },

  // Remove item from cart
  async removeItem(cartId, productId, size = null) {
    const normalizedSize = typeof size === 'string' ? size.trim() || null : size || null;
    let query = getDb().from('cart_items').delete().eq('cart_id', cartId).eq('product_id', productId);

    if (normalizedSize) {
      query = query.eq('size', normalizedSize);
    } else {
      query = query.is('size', null);
    }

    const { error } = await timeoutPromise(query);
    
    if (error) throw error;
    return true;
  },

  // Clear cart
  async clearCart(cartId) {
    const { error } = await timeoutPromise(
      getDb()
        .from('cart_items')
        .delete()
        .eq('cart_id', cartId)
    );
    
    if (error) throw error;
    return true;
  },

  // Merge guest cart to user cart (on login)
  async mergeCarts(userId, sessionId) {
    const { data: guestCart } = await timeoutPromise(
      getDb()
        .from('carts')
      .select('id')
      .eq('session_id', sessionId)
      .is('user_id', null)
      .single()
    );

    if (!guestCart) return null;

    const { data: userCart } = await getDb()
      .from('carts')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (!userCart) {
      const { error } = await getDb()
        .from('carts')
        .update({ user_id: userId, session_id: null })
        .eq('id', guestCart.id);
      if (error) throw error;
      return guestCart.id;
    }

    const { data: guestItems } = await getDb()
      .from('cart_items')
      .select('*')
      .eq('cart_id', guestCart.id);

    for (const item of guestItems || []) {
      await this.addItem(userCart.id, item.product_id, item.quantity, item.size || null);
    }

    await getDb().from('carts').delete().eq('id', guestCart.id);
    
    return userCart.id;
  }
};

// =====================================================
// ORDER SERVICE
// =====================================================
const orderService = {
  // Create order from cart
  async createFromCart(cartId, orderData) {
    // Get cart items with product details
    const { data: cartItems, error: cartError } = await getDb()
      .from('cart_items')
      .select(`
        *,
        products (id, name, category, price, image_url)
      `)
      .eq('cart_id', cartId);
    
    if (cartError) throw cartError;
    if (!cartItems || cartItems.length === 0) {
      throw new Error('Keranjang kosong');
    }

    // Calculate totals (no PPN)
    const subtotal = cartItems.reduce((sum, item) => {
      const unitPrice = Number(item.products.price || 0) + Number(item.size_price || 0);
      return sum + (unitPrice * item.quantity);
    }, 0);
    const tax = 0;
    const paymentFee = orderData.paymentFee || 0;
    const isPreorder = orderData.isPreorder || false;
    const dpPercentage = orderData.dpPercentage || 50;
    const discountAmount = orderData.discountAmount || 0;
    const dpAmount = isPreorder ? Math.round((subtotal - discountAmount) * dpPercentage / 100) : 0;
    const total = subtotal - discountAmount;

    // Generate order number
    const orderNumber = 'D25-' + Date.now().toString().slice(-8).toUpperCase();

    // Create order with standard status ('pending') to satisfy DB check constraint (orders_status_check)
    const formattedNotes = isPreorder
      ? `[PRE-ORDER DP ${dpPercentage}%: Rp ${dpAmount.toLocaleString('id-ID')}] ${orderData.notes || ''}`.trim()
      : (orderData.notes || null);

    const orderRow = {
      order_number: orderNumber,
      user_id: orderData.userId || null,
      customer_name: orderData.name,
      customer_email: orderData.email,
      customer_phone: orderData.phone,
      // Name tag (migrasi 005) menggantikan alamat pengiriman; fallback ke
      // customer_address agar data tetap tersimpan jika migrasi belum dijalankan
      customer_address: orderData.address || orderData.nameTag || null,
      customer_institution: orderData.institution || null,
      payment_method: orderData.paymentMethod,
      notes: formattedNotes,
      subtotal,
      tax,
      total,
      status: 'pending',
      payment_status: 'unpaid'
    };

    // Simpan name tag ke kolom khusus. Jika kolom name_tag belum ada di DB
    // (migrasi 005 belum dijalankan), ulangi insert tanpa name_tag.
    const orderRowWithNameTag = { ...orderRow, name_tag: orderData.nameTag || null };

    let { data: order, error: orderError } = await getDb()
      .from('orders')
      .insert([orderRowWithNameTag])
      .select()
      .single();

    if (orderError && (orderError.code === 'PGRST204' || /name_tag/i.test(orderError.message || ''))) {
      ({ data: order, error: orderError } = await getDb()
        .from('orders')
        .insert([orderRow])
        .select()
        .single());
    }

    if (orderError) throw orderError;

    // Create order items
    const orderItems = cartItems.map(item => {
      const sizePrice = Number(item.size_price || 0);
      const unitPrice = Number(item.products.price || 0) + sizePrice;
      return {
        order_id: order.id,
        product_id: item.products.id,
        product_name: item.products.name,
        product_category: item.products.category,
        product_image_url: item.products.image_url,
        size: item.size || null,
        size_price: sizePrice,
        quantity: item.quantity,
        unit_price: unitPrice,
        total_price: unitPrice * item.quantity
      };
    });

    const { error: itemsError } = await getDb()
      .from('order_items')
      .insert(orderItems);

    if (itemsError) throw itemsError;

    // Clear cart
    await getDb().from('cart_items').delete().eq('cart_id', cartId);

    // Return order with items
    const { data: fullOrder } = await getDb()
      .from('orders')
      .select(`
        *,
        order_items (*)
      `)
      .eq('id', order.id)
      .single();

    fullOrder.paymentFee = paymentFee; // Attach for Midtrans payload
    fullOrder.paymentMethodConfig = orderData.paymentMethodConfig; // Attach method config

    return fullOrder;
  },

  // Get order by ID
  async getById(id) {
    const { data, error } = await getDb()
      .from('orders')
      .select(`
        *,
        order_items (*)
      `)
      .eq('id', id)
      .single();
    
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },

  // Get order by order number
  async getByOrderNumber(orderNumber) {
    const { data, error } = await getDb()
      .from('orders')
      .select(`
        *,
        order_items (*)
      `)
      .eq('order_number', orderNumber)
      .single();
    
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },

  // Get user orders
  async getUserOrders(userId, limit = 20, offset = 0) {
    const { data, error } = await getDb()
      .from('orders')
      .select(`
        *,
        order_items (*)
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    
    if (error) throw error;
    return data || [];
  },

  // Get all orders (admin)
  async getAll(filters = {}) {
    let query = getDb()
      .from('orders')
      .select(`
        *,
        order_items (*)
      `)
      .order('created_at', { ascending: false });

    if (filters.status) {
      query = query.eq('status', filters.status);
    }
    if (filters.paymentStatus) {
      query = query.eq('payment_status', filters.paymentStatus);
    }
    if (filters.limit) {
      query = query.limit(filters.limit);
    }
    if (filters.offset) {
      query = query.range(filters.offset, filters.offset + filters.limit - 1);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  // Update order status (admin)
  async updateStatus(id, status, paymentStatus = null) {
    const updates = { status, updated_at: new Date().toISOString() };
    
    if (status === 'completed') {
      updates.completed_at = new Date().toISOString();
    } else if (status === 'cancelled') {
      updates.cancelled_at = new Date().toISOString();
    }
    
    if (paymentStatus) {
      updates.payment_status = paymentStatus;
      if (paymentStatus === 'paid') {
        updates.paid_at = new Date().toISOString();
      }
    }

    const { data, error } = await getDb()
      .from('orders')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // Delete order (admin)
  async delete(id) {
    const adminDb = getSupabaseAdmin();
    // Delete order_items first
    await adminDb.from('order_items').delete().eq('order_id', id);
    const { data, error } = await adminDb.from('orders').delete().eq('id', id).select();
    if (error) throw error;
    return data;
  },

  // Get order statistics (admin) - use admin client to bypass RLS
  async getStats() {
    const adminDb = getSupabaseAdmin();
    
    const { data: orders } = await adminDb
      .from('orders')
      .select('status, payment_status, total, created_at');

    if (!orders) return {
      totalOrders: 0,
      totalRevenue: 0,
      pendingOrders: 0,
      processingOrders: 0,
      completedOrders: 0,
      cancelledOrders: 0,
      totalProducts: 0
    };

    const { data: products } = await adminDb
      .from('products')
      .select('id', { count: 'exact' })
      .eq('active', true);

    return {
      totalOrders: orders.length,
      totalRevenue: orders.filter(o => o.payment_status === 'paid').reduce((sum, o) => sum + o.total, 0),
      pendingOrders: orders.filter(o => o.status === 'pending').length,
      processingOrders: orders.filter(o => o.status === 'processing').length,
      completedOrders: orders.filter(o => o.status === 'completed').length,
      cancelledOrders: orders.filter(o => o.status === 'cancelled').length,
      totalProducts: products?.length || 0
    };
  }
};

// =====================================================
// SETTINGS SERVICE
// =====================================================
const settingsService = {
  async get(key) {
    const { data, error } = await getDb()
      .from('settings')
      .select('value')
      .eq('key', key)
      .single();
    
    if (error) return null;
    return data?.value;
  },

  async getAll() {
    const { data, error } = await getDb()
      .from('settings')
      .select('*');
    
    if (error) throw error;
    
    const settings = {};
    data?.forEach(s => { settings[s.key] = s.value; });
    return settings;
  },

  async set(key, value, description = '') {
    const { data, error } = await getDb()
      .from('settings')
      .upsert([{ key, value, description, updated_at: new Date().toISOString() }])
      .select()
      .single();
    
    if (error) throw error;
    return data;
  }
};

// =====================================================
// AUTH HELPERS
// =====================================================
const authService = {
  // Get profile
  async getProfile(userId) {
    const { data, error } = await getDb()
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();
    
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },

  // Update profile
  async updateProfile(userId, updates) {
    const { data, error } = await getDb()
      .from('profiles')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', userId)
      .select()
      .single();
    
    if (error) throw error;
    return data;
  }
};

module.exports = {
  productService,
  cartService,
  orderService,
  settingsService,
  authService,
  getDb
};