-- =====================================================
-- MIGRATION 003: PERBAIKAN CONSTRAINT STATUS PESANAN
-- Jalankan di Supabase SQL Editor (setelah migration 001 & 002)
-- =====================================================
--
-- LATAR BELAKANG:
-- Webhook Midtrans & panel admin memakai nilai status berikut:
--   status          → 'pending', 'preorder', 'processing', 'ready',
--                     'completed', 'cancelled', 'refunded'
--   payment_status  → 'unpaid', 'pending', 'dp_paid', 'paid',
--                     'failed', 'refunded'
--
-- Migration 001 BELUM memuat 'preorder', 'ready', dan 'dp_paid'.
-- Akibatnya:
--   - Webhook Midtrans (bayar DP pre-order) akan gagal update database.
--   - Admin mengubah status ke "Pre Order", "Siap Dikirim/Pelunasan",
--     atau "DP Terbayar" akan gagal (check violation).
--
-- Fix: hapus constraint lama, tambahkan kembali dengan daftar lengkap.

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending', 'preorder', 'processing', 'ready', 'completed', 'cancelled', 'refunded'));

ALTER TABLE orders
  ADD CONSTRAINT orders_payment_status_check
  CHECK (payment_status IN ('unpaid', 'pending', 'dp_paid', 'paid', 'failed', 'refunded'));