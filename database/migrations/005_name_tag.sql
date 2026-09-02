-- =============================================================
-- MIGRASI 005: Kolom name_tag menggantikan alamat pengiriman
-- Jalankan di Supabase Dashboard -> SQL Editor (idempotent, aman diulang)
-- =============================================================

-- 1) Kolom baru untuk nama yang dicetak pada name tag
ALTER TABLE orders ADD COLUMN IF NOT EXISTS name_tag VARCHAR(100);

-- 2) Alamat pengiriman tidak lagi diisi dari form checkout (tidak dihapus,
--    data pesanan lama tetap utuh)
ALTER TABLE orders ALTER COLUMN customer_address DROP NOT NULL;

COMMENT ON COLUMN orders.name_tag IS 'Nama yang dicetak pada name tag produk (pengganti alamat pengiriman)';
