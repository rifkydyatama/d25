-- =====================================================
-- MIGRATION: Update products table for GENERAL PRODUCTS
-- Run this in Supabase SQL Editor
-- =====================================================

-- Add new columns for general products
ALTER TABLE products 
ADD COLUMN IF NOT EXISTS sku VARCHAR(100) UNIQUE,
ADD COLUMN IF NOT EXISTS brand VARCHAR(100),
ADD COLUMN IF NOT EXISTS stock INTEGER DEFAULT 0 CHECK (stock >= 0),
ADD COLUMN IF NOT EXISTS weight_gram INTEGER,
ADD COLUMN IF NOT EXISTS dimensions_cm VARCHAR(50), -- "LxWxH"
ADD COLUMN IF NOT EXISTS tags TEXT[],
ADD COLUMN IF NOT EXISTS specifications JSONB DEFAULT '{}',
ADD COLUMN IF NOT EXISTS warranty_months INTEGER,
ADD COLUMN IF NOT EXISTS is_digital BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS digital_file_url TEXT;

-- Rename category to be more generic (optional, keep for backward compat)
-- Categories will now be: Elektronik, Fashion, Rumah Tangga, Kesehatan, Olahraga, dll

-- Add index for SKU
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);
CREATE INDEX IF NOT EXISTS idx_products_stock ON products(stock) WHERE stock > 0;

-- Update order_items table to include product_sku, product_brand and selected size
ALTER TABLE order_items
ADD COLUMN IF NOT EXISTS product_sku VARCHAR(100),
ADD COLUMN IF NOT EXISTS product_brand VARCHAR(100),
ADD COLUMN IF NOT EXISTS size VARCHAR(20),
ADD COLUMN IF NOT EXISTS size_price INTEGER NOT NULL DEFAULT 0;

-- Update cart_items table to support per-size variants in the cart
ALTER TABLE cart_items
ADD COLUMN IF NOT EXISTS size VARCHAR(20),
ADD COLUMN IF NOT EXISTS size_price INTEGER NOT NULL DEFAULT 0;

-- Remove legacy unique constraint that only keyed on product_id to avoid conflicts when size variants exist
ALTER TABLE cart_items
DROP CONSTRAINT IF EXISTS cart_items_cart_id_product_id_key;

-- Remove duplicated legacy rows created before size support existed
DELETE FROM cart_items a
USING cart_items b
WHERE a.id > b.id
  AND a.cart_id = b.cart_id
  AND a.product_id = b.product_id
  AND a.size IS NOT DISTINCT FROM b.size;

CREATE UNIQUE INDEX IF NOT EXISTS cart_items_cart_id_product_id_size_key
ON cart_items (cart_id, product_id, size);

-- =====================================================

-- Update existing products to have generic structure
-- (Run this after adding columns)

-- =====================================================
-- SEED DATA: GENERAL PRODUCTS EXAMPLES
-- =====================================================
INSERT INTO products (name, slug, category, price, original_price, description, brand, stock, weight_gram, dimensions_cm, tags, specifications, warranty_months, image_url, popular, sku) VALUES
-- Elektronik
('Wireless Headphones Pro', 'wireless-headphones-pro', 'Elektronik', 899000, 1200000, 'Headphone nirkabel dengan noise cancelling, battery 30 jam, kualitas suara Hi-Res', 'Sony', 50, 250, '20x18x8', ARRAY['wireless', 'noise-cancelling', 'bluetooth'], '{"driver": "40mm", "frequency": "4Hz-40kHz", "battery": "30 hours", "charging": "USB-C"}', 12, '/images/headphones.jpg', TRUE, 'SNY-WHP-001'),

('Mechanical Keyboard RGB', 'mechanical-keyboard-rgb', 'Elektronik', 650000, 850000, 'Keyboard mekanis switch Red, RGB per-key, aluminum frame, hot-swappable', 'Keychron', 30, 950, '32x14x4', ARRAY['mechanical', 'rgb', 'hot-swappable'], '{"switch": "Gateron Red", "layout": "TKL", "connectivity": "USB-C + Bluetooth 5.1", "battery": "4000mAh"}', 12, '/images/keyboard.jpg', TRUE, 'KYC-KBD-002'),

('Portable SSD 1TB', 'portable-ssd-1tb', 'Elektronik', 1200000, 1500000, 'SSD portable NVMe 1TB, baca 1050MB/s, USB 3.2 Gen 2x2, compact', 'Samsung', 25, 50, '10x6x1', ARRAY['ssd', 'nvme', 'portable'], '{"capacity": "1TB", "interface": "USB 3.2 Gen 2x2", "read_speed": "1050MB/s", "write_speed": "1000MB/s", "encryption": "AES 256-bit"}', 36, '/images/ssd.jpg', FALSE, 'SAM-SSD-003'),

-- Fashion
('Kaos Polos Premium Cotton', 'kaos-polos-premium', 'Fashion', 89000, 120000, 'Kaos 100% cotton combed 30s, preshrunk, anti-pilling, fit regular', 'Unbranded', 200, 180, '30x40x2', ARRAY['cotton', 'casual', 'daily-wear'], '{"material": "100% Cotton Combed 30s", "weight": "180gsm", "fit": "Regular", "care": "Machine wash cold"}', 0, '/images/tshirt.jpg', TRUE, 'UNB-TSH-001'),

('Celana Chino Slim Fit', 'celana-chino-slim', 'Fashion', 199000, 250000, 'Celana chino 98% cotton 2% spandex, stretch comfortable, slim fit modern', 'Levis', 75, 350, '35x30x2', ARRAY['chino', 'slim-fit', 'stretch'], '{"material": "98% Cotton 2% Spandex", "fit": "Slim", "closure": "Zipper + Button", "pockets": "5"}', 0, '/images/chino.jpg', FALSE, 'LEV-CHN-002'),

-- Rumah Tangga
('Air Fryer 5.5L Digital', 'air-fryer-5.5l', 'Rumah Tangga', 799000, 1100000, 'Air fryer 5.5L, 8 preset menu, touch screen, non-stick basket, dishwasher safe', 'Philips', 20, 4200, '35x30x32', ARRAY['airfryer', 'healthy-cooking', 'digital'], '{"capacity": "5.5L", "power": "1700W", "temperature": "80-200°C", "presets": 8, "basket": "Non-stick, dishwasher safe"}', 12, '/images/airfryer.jpg', TRUE, 'PHP-AFR-001'),

('Robot Vacuum Cleaner', 'robot-vacuum', 'Rumah Tangga', 2499000, 3200000, 'Robot vakum cerdas, mapping LIDAR, mopping, app control, auto-charge, 5000Pa', 'Xiaomi', 15, 3500, '35x35x10', ARRAY['robot', 'vacuum', 'mopping', 'lidar'], '{"suction": "5000Pa", "battery": "5200mAh", "runtime": "180min", "navigation": "LIDAR SLAM", "water_tank": "300ml"}', 24, '/images/robotvac.jpg', FALSE, 'XIA-RVC-001'),

-- Kesehatan & Kecantikan
('Skincare Set Glowing', 'skincare-set-glowing', 'Kesehatan', 450000, 600000, 'Set skincare lengkap: cleanser, toner, serum vitamin C, moisturizer, sunscreen SPF50', 'Somethinc', 100, 500, '20x15x8', ARRAY['skincare', 'vitamin-c', 'glowing'], '{"steps": 5, "skin_type": "All skin types", "key_ingredients": ["Vitamin C", "Niacinamide", "Hyaluronic Acid", "Ceramide"], "halal": true}', 0, '/images/skincare.jpg', TRUE, 'SMT-SKC-001'),

-- Olahraga
('Yoga Mat Premium TPE', 'yoga-mat-tpe', 'Olahraga', 150000, 200000, 'Mat yoga TPE eco-friendly 6mm, anti-slip, alignment lines, carrying strap', 'Gaiam', 60, 1200, '183x61x0.6', ARRAY['yoga', 'eco-friendly', 'anti-slip'], '{"material": "TPE Eco-friendly", "thickness": "6mm", "dimensions": "183x61cm", "features": ["Alignment lines", "Anti-slip", "Carrying strap"]}', 0, '/images/yogamat.jpg', FALSE, 'GIA-YOG-001'),

-- Digital Product
('E-Book: Belajar Coding Pemula', 'ebook-coding-pemula', 'Digital', 50000, 75000, 'E-book lengkap belajar programming dari nol: HTML, CSS, JavaScript, Python basics', 'D25 Press', 9999, 0, '', ARRAY['ebook', 'programming', 'beginner'], '{"format": "PDF + EPUB", "pages": 280, "language": "Indonesian", "chapters": 12, "exercises": 50}', 0, '/images/ebook.jpg', TRUE, 'D25-EBK-001', TRUE),

-- Bundle
('Starter Kit Work From Home', 'starter-kit-wfh', 'Bundle', 1999000, 2800000, 'Paket lengkap WFH: Mechanical keyboard + Wireless mouse + Laptop stand + Cable organizer', 'WFH Bundle', 10, 2500, '40x30x15', ARRAY['wfh', 'bundle', 'productivity'], '{"includes": ["Mechanical Keyboard", "Wireless Mouse", "Aluminum Laptop Stand", "Cable Organizer"], "warranty": "12 months"}', 12, '/images/wfhkit.jpg', TRUE, 'WFH-KIT-001')
ON CONFLICT (slug) DO NOTHING;

-- =====================================================
-- UPDATE CATEGORIES TABLE
-- =====================================================
DELETE FROM categories;

INSERT INTO categories (name, slug, description, icon, sort_order) VALUES
('Elektronik', 'elektronik', 'Gadget, aksesoris komputer, audio, smartphone', 'smartphone', 1),
('Fashion', 'fashion', 'Pakaian, sepatu, aksesoris pria & wanita', 'shirt', 2),
('Rumah Tangga', 'rumah-tangga', 'Peralatan rumah, dekorasi, peralatan masak', 'home', 3),
('Kesehatan & Kecantikan', 'kesehatan-kecantikan', 'Skincare, suplemen, peralatan kesehatan', 'heart', 4),
('Olahraga', 'olahraga', 'Peralatan fitness, outdoor, yoga, running', 'dumbbell', 5),
('Digital', 'digital', 'E-book, software, course digital, template', 'file-text', 6),
('Bundle', 'bundle', 'Paket hemat kombinasi produk', 'package', 7)
ON CONFLICT (slug) DO NOTHING;

-- =====================================================
-- CREATE PRODUCT IMAGES TABLE (for multiple images)
-- =====================================================
CREATE TABLE IF NOT EXISTS product_images (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,
    alt_text VARCHAR(255),
    is_primary BOOLEAN DEFAULT FALSE,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id);