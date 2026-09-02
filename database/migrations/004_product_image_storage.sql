-- =====================================================
-- 004: STORAGE BUCKET FOTO PRODUK (upload, bukan URL)
-- Jalankan di Supabase Dashboard > SQL Editor.
-- Bucket "product-images" dipakai fitur upload foto
-- produk admin (lib/upload.js + POST /admin/upload).
-- =====================================================

-- Pastikan bucket public tersedia (idempotent)
INSERT INTO storage.buckets (id, name, public)
VALUES ('product-images', 'product-images', TRUE)
ON CONFLICT (id) DO NOTHING;

-- Izinkan pembacaan publik (URL foto produk bisa diakses tanpa login)
DROP POLICY IF EXISTS "Public read product-images" ON storage.objects;
CREATE POLICY "Public read product-images"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'product-images');

-- Catatan: upload dilakukan dari server (admin) memakai
-- SUPABASE_SERVICE_ROLE_KEY yang otomatis melewati RLS,
-- sehingga tidak perlu policy INSERT untuk anon/authenticated.
