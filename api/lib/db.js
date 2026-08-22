const { supabaseAdmin } = require('./supabase');

function formatRupiah(angka) {
  return 'Rp ' + Number(angka).toLocaleString('id-ID');
}

// =====================================================
// PRODUCTS SERVICE
// =====================================================
const productService = {
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
      // General product fields
      sku: p.sku,
      brand: p.brand,
      stock: p.stock,
      weightGram: p.weight_gram,
      dimensionsCm: p.dimensions_cm,
      tags: p.tags,
      specifications: p.specifications,
      warrantyMonths: p.warranty_months,
      isDigital: p.is_digital,
      digitalFileUrl: p.digital_file_url,
      // Legacy fields (for backward compat)
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

  async getAll(filters = {}) {
    let query = supabaseAdmin
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

    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map(this.mapProduct);
  },

  async getById(id) {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select('*')
      .eq('id', id)
      .eq('active', true)
      .single();
    
    if (error && error.code !== 'PGRST116') throw error;
    return this.mapProduct(data);
  },

  async getCategories() {
    const { data, error } = await supabaseAdmin
      .from('categories')
      .select('*')
      .eq('active', true)
      .order('sort_order');
    
    if (error) throw error;
    return data || [];
  }
};

// =====================================================
// CART SERVICE
// =====================================================
const cartService = {
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
      // General product fields
      sku: p.sku,
      brand: p.brand,
      stock: p.stock,
      weightGram: p.weight_gram,
      dimensionsCm: p.dimensions_cm,
      tags: p.tags,
      specifications: p.specifications,
      warrantyMonths: p.warranty_months,
      isDigital: p.is_digital,
      digitalFileUrl: p.digital_file_url,
      // Legacy fields
      instructor: p.instructor,
      duration: p.duration,
      level: p.level,
      image: p.image_url,
      imageUrl: p.image_url,
      popular: p.popular,
      quantity: item.quantity,
      size: item.size || null,
      cartItemId: item.id
    };
  },

  async getOrCreateCart(userId, sessionId) {
    let cart;
    
    if (userId) {
      const { data: existingCart } = await supabaseAdmin
        .from('carts')
        .select('*')
        .eq('user_id', userId)
        .single();
      
      if (existingCart) {
        cart = existingCart;
      } else {
        const { data: newCart, error } = await supabaseAdmin
          .from('carts')
          .insert([{ user_id: userId }])
          .select()
          .single();
        if (error) throw error;
        cart = newCart;
      }
    } else if (sessionId) {
      const { data: existingCart } = await supabaseAdmin
        .from('carts')
        .select('*')
        .eq('session_id', sessionId)
        .is('user_id', null)
        .single();
      
      if (existingCart) {
        cart = existingCart;
      } else {
        const { data: newCart, error } = await supabaseAdmin
          .from('carts')
          .insert([{ session_id: sessionId }])
          .select()
          .single();
        if (error) throw error;
        cart = newCart;
      }
    }
    
    return cart;
  },

  async getCartWithItems(cartId) {
    const { data, error } = await supabaseAdmin
      .from('cart_items')
      .select(`
        *,
        products (
          id, name, category, price, original_price, 
          image_url, popular, sku, brand, stock, weight_gram, 
          dimensions_cm, tags, specifications, warranty_months,
          is_digital, digital_file_url,
          instructor, duration, level
        )
      `)
      .eq('cart_id', cartId);
    
    if (error) throw error;
    
    return (data || []).map(item => this.mapCartItem(item));
  },

  async addItem(cartId, productId, quantity = 1, size = null, sizePrice = 0) {
    const normalizedSize = typeof size === 'string' ? size.trim() || null : size || null;
    const normalizedSizePrice = Number(sizePrice) || 0;

    let matchingQuery = supabaseAdmin
      .from('cart_items')
      .select('*')
      .eq('cart_id', cartId)
      .eq('product_id', productId);

    if (normalizedSize) {
      matchingQuery = matchingQuery.eq('size', normalizedSize);
    } else {
      matchingQuery = matchingQuery.is('size', null);
    }

    const { data: existing } = await matchingQuery.maybeSingle();

    if (existing) {
      const newQuantity = Math.min(existing.quantity + quantity, 10);
      const { data, error } = await supabaseAdmin
        .from('cart_items')
        .update({ quantity: newQuantity, size_price: normalizedSizePrice, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      return data;
    } else {
      const insertPayload = { cart_id: cartId, product_id: productId, quantity, size_price: normalizedSizePrice };
      if (normalizedSize) insertPayload.size = normalizedSize;

      const { data, error } = await supabaseAdmin
        .from('cart_items')
        .insert([insertPayload])
        .select()
        .single();
      if (error) throw error;
      return data;
    }
  },

  async updateQuantity(cartId, productId, quantity, size = null) {
    const normalizedSize = typeof size === 'string' ? size.trim() || null : size || null;
    let query = supabaseAdmin
      .from('cart_items')
      .update({ quantity: Math.min(Math.max(quantity, 1), 10), updated_at: new Date().toISOString() })
      .eq('cart_id', cartId)
      .eq('product_id', productId);

    if (normalizedSize) {
      query = query.eq('size', normalizedSize);
    } else {
      query = query.is('size', null);
    }

    const { data, error } = await query.select().single();
    
    if (error) throw error;
    return data;
  },

  async removeItem(cartId, productId, size = null) {
    const normalizedSize = typeof size === 'string' ? size.trim() || null : size || null;
    let query = supabaseAdmin.from('cart_items').delete().eq('cart_id', cartId).eq('product_id', productId);

    if (normalizedSize) {
      query = query.eq('size', normalizedSize);
    } else {
      query = query.is('size', null);
    }

    const { error } = await query;
    
    if (error) throw error;
    return true;
  },

  async clearCart(cartId) {
    const { error } = await supabaseAdmin
      .from('cart_items')
      .delete()
      .eq('cart_id', cartId);
    
    if (error) throw error;
    return true;
  }
};

// =====================================================
// ORDER SERVICE
// =====================================================
const orderService = {
  async createFromCart(cartId, orderData) {
    const { data: cartItems, error: cartError } = await supabaseAdmin
      .from('cart_items')
      .select(`
        *,
        products (id, name, category, price, original_price, image_url, sku, brand, is_digital)
      `)
      .eq('cart_id', cartId);
    
    if (cartError) throw cartError;
    if (!cartItems || cartItems.length === 0) {
      throw new Error('Keranjang kosong');
    }

    const subtotal = cartItems.reduce((sum, item) => {
      const unitPrice = Number(item.products.price || 0) + Number(item.size_price || 0);
      return sum + (unitPrice * item.quantity);
    }, 0);
    const tax = 0;
    const total = subtotal;

    const orderNumber = 'D25-' + Date.now().toString().slice(-8).toUpperCase();

    const { data: order, error: orderError } = await supabaseAdmin
      .from('orders')
      .insert([{
        order_number: orderNumber,
        user_id: orderData.userId || null,
        customer_name: orderData.name,
        customer_email: orderData.email,
        customer_phone: orderData.phone,
        customer_address: orderData.address,
        customer_institution: orderData.institution || null,
        payment_method: orderData.paymentMethod,
        notes: orderData.notes || null,
        subtotal,
        tax,
        total,
        status: 'pending',
        payment_status: 'unpaid'
      }])
      .select()
      .single();

    if (orderError) throw orderError;

    const orderItems = cartItems.map(item => {
      const sizePrice = Number(item.size_price || 0);
      const unitPrice = Number(item.products.price || 0) + sizePrice;
      return {
        order_id: order.id,
        product_id: item.products.id,
        product_name: item.products.name,
        product_category: item.products.category,
        product_image_url: item.products.image_url,
        product_sku: item.products.sku,
        product_brand: item.products.brand,
        size: item.size || null,
        size_price: sizePrice,
        quantity: item.quantity,
        unit_price: unitPrice,
        total_price: unitPrice * item.quantity
      };
    });

    const { error: itemsError } = await supabaseAdmin
      .from('order_items')
      .insert(orderItems);

    if (itemsError) throw itemsError;

    await supabaseAdmin.from('cart_items').delete().eq('cart_id', cartId);

    const { data: fullOrder } = await supabaseAdmin
      .from('orders')
      .select(`
        *,
        order_items (*)
      `)
      .eq('id', order.id)
      .single();

    return fullOrder;
  },

  async getById(id) {
    const { data, error } = await supabaseAdmin
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

  async getByOrderNumber(orderNumber) {
    const { data, error } = await supabaseAdmin
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

  async getAll(filters = {}) {
    let query = supabaseAdmin
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

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

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

    const { data, error } = await supabaseAdmin
      .from('orders')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async getStats() {
    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select('status, payment_status, total, created_at');

    if (!orders) return {
      totalOrders: 0,
      totalRevenue: 0,
      pendingOrders: 0,
      completedOrders: 0,
      totalProducts: 0
    };

    const { data: products } = await supabaseAdmin
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

module.exports = { productService, cartService, orderService };