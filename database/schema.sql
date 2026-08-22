-- =====================================================
-- D25 TEKNOLOGI PENDIDIKAN - SUPABASE DATABASE SCHEMA
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- =====================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- 1. PRODUCTS TABLE
-- =====================================================
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    category VARCHAR(100) NOT NULL,
    price INTEGER NOT NULL CHECK (price >= 0),
    original_price INTEGER CHECK (original_price >= 0),
    description TEXT,
    instructor VARCHAR(255),
    duration VARCHAR(100),
    level VARCHAR(100),
    image_url TEXT,
    popular BOOLEAN DEFAULT FALSE,
    active BOOLEAN DEFAULT TRUE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for better query performance
CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_popular ON products(popular) WHERE popular = TRUE;
CREATE INDEX idx_products_active ON products(active) WHERE active = TRUE;

-- =====================================================
-- 2. USERS TABLE (extends Supabase Auth)
-- =====================================================
CREATE TABLE profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    full_name VARCHAR(255),
    phone VARCHAR(50),
    institution VARCHAR(255),
    role VARCHAR(50) DEFAULT 'student' CHECK (role IN ('student', 'instructor', 'admin')),
    avatar_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Policies for profiles
CREATE POLICY "Public profiles are viewable by everyone" ON profiles
    FOR SELECT USING (true);

CREATE POLICY "Users can insert their own profile" ON profiles
    FOR INSERT WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can update their own profile" ON profiles
    FOR UPDATE USING (auth.uid() = id);

-- =====================================================
-- 2b. AUTO-CREATE PROFILE TRIGGER (bypass RLS)
-- =====================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, full_name, role)
    VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'full_name', 'student')
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =====================================================
-- 3. ORDERS TABLE
-- =====================================================
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_number VARCHAR(50) UNIQUE NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'cancelled', 'refunded')),
    payment_method VARCHAR(50),
    payment_status VARCHAR(50) DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid', 'failed', 'refunded')),
    payment_id VARCHAR(255), -- BRI VA number, transaction ID, etc.
    
    -- Customer info (denormalized for order history)
    customer_name VARCHAR(255) NOT NULL,
    customer_email VARCHAR(255) NOT NULL,
    customer_phone VARCHAR(50) NOT NULL,
    customer_address TEXT NOT NULL,
    customer_institution VARCHAR(255),
    notes TEXT,
    
    -- Pricing
    subtotal INTEGER NOT NULL DEFAULT 0,
    tax INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    
    -- Timestamps
    paid_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_payment_status ON orders(payment_status);
CREATE INDEX idx_orders_created_at ON orders(created_at DESC);

-- Enable RLS
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- Policies for orders
CREATE POLICY "Users can view their own orders" ON orders
    FOR SELECT USING (auth.uid() = user_id OR auth.jwt() ->> 'role' = 'admin');

CREATE POLICY "Users can create their own orders" ON orders
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins can view all orders" ON orders
    FOR SELECT USING (auth.jwt() ->> 'role' = 'admin');

CREATE POLICY "Admins can update all orders" ON orders
    FOR UPDATE USING (auth.jwt() ->> 'role' = 'admin');

-- =====================================================
-- 4. ORDER ITEMS TABLE
-- =====================================================
CREATE TABLE order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id) ON DELETE SET NULL,
    product_name VARCHAR(255) NOT NULL,
    product_category VARCHAR(100),
    product_image_url TEXT,
    size VARCHAR(20),
    size_price INTEGER NOT NULL DEFAULT 0,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
    total_price INTEGER NOT NULL CHECK (total_price >= 0),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_order_items_order_id ON order_items(order_id);
CREATE INDEX idx_order_items_product_id ON order_items(product_id);

-- Enable RLS
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own order items" ON order_items
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM orders 
            WHERE orders.id = order_items.order_id 
            AND (orders.user_id = auth.uid() OR auth.jwt() ->> 'role' = 'admin')
        )
    );

CREATE POLICY "Admins can manage all order items" ON order_items
    FOR ALL USING (auth.jwt() ->> 'role' = 'admin');

-- =====================================================
-- 5. CART TABLE (Persistent cart)
-- =====================================================
CREATE TABLE carts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    session_id VARCHAR(255), -- For guest carts
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_carts_user_id ON carts(user_id);
CREATE INDEX idx_carts_session_id ON carts(session_id);

CREATE TABLE cart_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cart_id UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    size VARCHAR(20),
    size_price INTEGER NOT NULL DEFAULT 0,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0 AND quantity <= 10),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(cart_id, product_id, size)
);

CREATE INDEX idx_cart_items_cart_id ON cart_items(cart_id);

-- Enable RLS
ALTER TABLE carts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cart_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own cart" ON carts
    FOR ALL USING (auth.uid() = user_id OR (user_id IS NULL AND session_id = current_setting('request.jwt.claims', true)::json ->> 'session_id'));

CREATE POLICY "Users can manage their own cart items" ON cart_items
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM carts 
            WHERE carts.id = cart_items.cart_id 
            AND (carts.user_id = auth.uid() OR (carts.user_id IS NULL AND carts.session_id = current_setting('request.jwt.claims', true)::json ->> 'session_id'))
        )
    );

-- =====================================================
-- 6. CATEGORIES TABLE (Optional - for dynamic categories)
-- =====================================================
CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) UNIQUE NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    icon VARCHAR(100),
    sort_order INTEGER DEFAULT 0,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 7. SETTINGS TABLE (Site configuration)
-- =====================================================
CREATE TABLE settings (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 8. TRIGGERS FOR UPDATED_AT
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_cart_items_updated_at BEFORE UPDATE ON cart_items
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_carts_updated_at BEFORE UPDATE ON carts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- 9. INITIAL DATA - SEED PRODUCTS
-- =====================================================
INSERT INTO products (name, slug, category, price, original_price, description, instructor, duration, level, image_url, popular) VALUES
('Kelas Private TKJ', 'kelas-private-tkj', 'Private', 150000, 200000, 'Les privat Teknik Komputer dan Jaringan berdasarkan kurikulum D25 Teknologi Pendidikan.', 'Riko Wijaya, S.Pd.', '12 sesi (2x seminggu)', 'Pemula - Lanjutan', '/images/product-tkj.svg', TRUE),
('Kelas Pemrograman Dasar', 'kelas-pemrograman-dasar', 'Umum', 100000, 150000, 'Belajar dasar-dasar pemrograman menggunakan Python dan JavaScript untuk pemula.', 'Siti Aminah, M.Pd.', '8 sesi (1x seminggu)', 'Pemula', '/images/product-pemrograman.svg', TRUE),
('Kelas Multimedia & Desain', 'kelas-multimedia-desain', 'Desain', 120000, 180000, 'Kursus desain grafis dengan Canva, Photoshop dasar, dan animasi sederhana.', 'Andi Pratama, S.Pd.', '10 sesi (1x seminggu)', 'Pemula - Menengah', '/images/product-multimedia.svg', FALSE),
('Kelas Robotik Dasar', 'kelas-robotik-dasar', 'Ekstrakurikuler', 200000, 250000, 'Pembuatan robot dasar menggunakan Arduino dan sensor-sensor IoT.', 'Dewi Lestari, S.T.', '16 sesi (2x seminggu)', 'Menengah', '/images/product-robotik.svg', FALSE),
('Kelas Matematika Diskrit', 'kelas-matematika-diskrit', 'Akademik', 80000, 120000, 'Pembelajaran matematika diskrit untuk ilmu komputer dan teknik.', 'Budi Santoso, M.Pd.', '6 sesi (1x seminggu)', 'Menengah', '/images/product-matematika.svg', FALSE),
('Paket Lengkap Semua Kelas', 'paket-lengkap-semua-kelas', 'Bundle', 350000, 650000, 'Akses ke semua kelas yang ditawarkan D25 Teknologi Pendidikan selama satu semester.', 'Tim D25 Teknologi Pendidikan', 'Semester penuh', 'Semua level', '/images/product-bundle.svg', TRUE)
ON CONFLICT (slug) DO NOTHING;

-- Insert default categories
INSERT INTO categories (name, slug, description, icon, sort_order) VALUES
('Private', 'private', 'Kelas privat one-on-one', 'user', 1),
('Umum', 'umum', 'Kelas umum untuk semua level', 'users', 2),
('Desain', 'desain', 'Kelas desain grafis dan multimedia', 'palette', 3),
('Ekstrakurikuler', 'ekstrakurikuler', 'Kelas kegiatan ekstrakurikuler', 'activity', 4),
('Akademik', 'akademik', 'Kelas mata kuliah akademik', 'book-open', 5),
('Bundle', 'bundle', 'Paket hemat kombinasi kelas', 'package', 6)
ON CONFLICT (slug) DO NOTHING;

-- Insert default settings
INSERT INTO settings (key, value, description) VALUES
('site_name', '"D25 Teknologi Pendidikan"', 'Nama situs'),
('site_description', '"Program Studi Teknologi Pendidikan, Fakultas Ilmu Pendidikan, Universitas Negeri Malang"', 'Deskripsi situs'),
('contact_email', '"d25teknopendidikan@um.ac.id"', 'Email kontak'),
('contact_phone', '"+62 812-3456-7890"', 'Nomor telepon'),
('contact_address', '"Jl. Semarang No.5, Sumbersari, Kec. Lowokwaru, Kota Malang, Jawa Timur 65145"', 'Alamat lengkap'),
('tax_rate', '0.1', 'Persentase pajak (0.1 = 10%)'),
('currency', '"IDR"', 'Mata uang'),
('payment_methods', '["bri_virtual_account", "bank_transfer", "ewallet"]', 'Metode pembayaran yang tersedia'),
('max_cart_quantity', '10', 'Maksimal quantity per item di keranjang')
ON CONFLICT (key) DO NOTHING;

-- =====================================================
-- 10. HELPER FUNCTIONS
-- =====================================================

-- Function to get cart with items
CREATE OR REPLACE FUNCTION get_cart_with_items(p_user_id UUID, p_session_id TEXT)
RETURNS TABLE (
    cart_id UUID,
    product_id UUID,
    product_name VARCHAR,
    product_category VARCHAR,
    product_price INTEGER,
    product_original_price INTEGER,
    product_image_url TEXT,
    product_popular BOOLEAN,
    quantity INTEGER,
    subtotal INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        c.id as cart_id,
        p.id as product_id,
        p.name as product_name,
        p.category as product_category,
        p.price as product_price,
        p.original_price as product_original_price,
        p.image_url as product_image_url,
        p.popular as product_popular,
        ci.quantity,
        (p.price * ci.quantity) as subtotal
    FROM carts c
    JOIN cart_items ci ON ci.cart_id = c.id
    JOIN products p ON p.id = ci.product_id
    WHERE (c.user_id = p_user_id OR (c.user_id IS NULL AND c.session_id = p_session_id))
    AND p.active = TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to create order from cart
CREATE OR REPLACE FUNCTION create_order_from_cart(
    p_user_id UUID,
    p_session_id TEXT,
    p_customer_name VARCHAR,
    p_customer_email VARCHAR,
    p_customer_phone VARCHAR,
    p_customer_address TEXT,
    p_customer_institution VARCHAR,
    p_payment_method VARCHAR,
    p_notes TEXT
)
RETURNS UUID AS $$
DECLARE
    v_cart_id UUID;
    v_order_id UUID;
    v_order_number VARCHAR;
    v_subtotal INTEGER := 0;
    v_tax INTEGER := 0;
    v_total INTEGER := 0;
    v_tax_rate NUMERIC := 0.1;
BEGIN
    -- Get cart
    SELECT id INTO v_cart_id
    FROM carts
    WHERE (user_id = p_user_id OR (user_id IS NULL AND session_id = p_session_id))
    LIMIT 1;
    
    IF v_cart_id IS NULL THEN
        RAISE EXCEPTION 'Cart not found';
    END IF;
    
    -- Calculate totals
    SELECT COALESCE(SUM(p.price * ci.quantity), 0) INTO v_subtotal
    FROM cart_items ci
    JOIN products p ON p.id = ci.product_id
    WHERE ci.cart_id = v_cart_id;
    
    v_tax := ROUND(v_subtotal * v_tax_rate);
    v_total := v_subtotal + v_tax;
    
    -- Generate order number
    v_order_number := 'D25-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');
    
    -- Create order
    INSERT INTO orders (
        order_number, user_id, customer_name, customer_email, customer_phone,
        customer_address, customer_institution, payment_method, notes,
        subtotal, tax, total, status, payment_status
    ) VALUES (
        v_order_number, p_user_id, p_customer_name, p_customer_email, p_customer_phone,
        p_customer_address, p_customer_institution, p_payment_method, p_notes,
        v_subtotal, v_tax, v_total, 'pending', 'unpaid'
    ) RETURNING id INTO v_order_id;
    
    -- Create order items
    INSERT INTO order_items (order_id, product_id, product_name, product_category, product_image_url, quantity, unit_price, total_price)
    SELECT 
        v_order_id,
        p.id,
        p.name,
        p.category,
        p.image_url,
        ci.quantity,
        p.price,
        (p.price * ci.quantity)
    FROM cart_items ci
    JOIN products p ON p.id = ci.product_id
    WHERE ci.cart_id = v_cart_id;
    
    -- Clear cart
    DELETE FROM cart_items WHERE cart_id = v_cart_id;
    
    RETURN v_order_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- 11. STORAGE BUCKET FOR PRODUCT IMAGES
-- =====================================================
-- Run this in Storage section or via SQL:
-- INSERT INTO storage.buckets (id, name, public) VALUES ('product-images', 'product-images', true);
-- CREATE POLICY "Public read access" ON storage.objects FOR SELECT USING (bucket_id = 'product-images');
-- CREATE POLICY "Authenticated users can upload" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'product-images' AND auth.role() = 'authenticated');