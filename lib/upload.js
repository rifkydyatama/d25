// =====================================================
// UPLOAD HELPER - Foto Produk ke Supabase Storage
// =====================================================
// Memakai multer memoryStorage agar aman dijalankan di
// serverless (Vercel) maupun server biasa, lalu file
// diunggah ke bucket "product-images" Supabase Storage.
// Server memakai SUPABASE_SERVICE_ROLE_KEY sehingga
// upload tidak terpengaruh RLS dan anon key tetap aman.
// =====================================================
const multer = require('multer');
const { randomUUID } = require('crypto');
const { getSupabaseAdmin } = require('./supabase');

const BUCKET_NAME = 'product-images';
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

// Tipe file gambar yang diizinkan -> ekstensi penyimpanan
const ALLOWED_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/avif': '.avif'
};

// Middleware multer: validasi tipe + ukuran, simpan di memori
const uploadProductPhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME[file.mimetype]) {
      const err = new Error('Tipe file tidak didukung. Gunakan JPG, PNG, WEBP, GIF, SVG, atau AVIF.');
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  }
});

function getBucket() {
  return getSupabaseAdmin().storage.from(BUCKET_NAME);
}

// Pastikan bucket ada (dibuat public jika belum ada)
async function ensureBucket() {
  const admin = getSupabaseAdmin();
  const { data: buckets, error } = await admin.storage.listBuckets();
  if (error) throw error;
  if (!(buckets || []).some((b) => b.name === BUCKET_NAME)) {
    const { error: createError } = await admin.storage.createBucket(BUCKET_NAME, { public: true });
    if (createError && !/exists/i.test(createError.message || '')) throw createError;
  }
}

// Upload buffer gambar ke Supabase Storage, kembalikan public URL
async function uploadProductImage(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    const err = new Error('File foto tidak ditemukan');
    err.status = 400;
    throw err;
  }

  const ext = ALLOWED_MIME[file.mimetype] || '.jpg';
  const objectName = `products/${randomUUID()}${ext}`;

  const { error } = await getBucket().upload(objectName, file.buffer, {
    contentType: file.mimetype,
    cacheControl: '3600',
    upsert: false
  });

  // Bucket belum ada -> buat lalu coba lagi sekali
  if (error && /not\s*found|bucket/i.test(error.message || '')) {
    await ensureBucket();
    const retry = await getBucket().upload(objectName, file.buffer, {
      contentType: file.mimetype,
      cacheControl: '3600',
      upsert: false
    });
    if (retry.error) throw retry.error;
  } else if (error) {
    throw error;
  }

  const { data } = getBucket().getPublicUrl(objectName);
  if (!data || !data.publicUrl) {
    throw new Error('Gagal mendapatkan URL publik foto');
  }
  return data.publicUrl;
}

module.exports = { uploadProductPhoto, uploadProductImage, BUCKET_NAME, MAX_FILE_SIZE, ALLOWED_MIME };
