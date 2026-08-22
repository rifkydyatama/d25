// Email Service for Order Notifications
const nodemailer = require('nodemailer');
const logger = require('./logger');

let transporter = null;

function initTransporter() {
  if (!process.env.EMAIL_HOST || !process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    logger.warn('Email config not set, emails will be logged only');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    },
    pool: true,
    maxConnections: 5,
    rateDelta: 1000,
    rateLimit: 5
  });

  transporter.verify((err) => {
    if (err) {
      logger.error('Email transporter verification failed', { error: err.message });
    } else {
      logger.info('Email transporter ready');
    }
  });

  return transporter;
}

async function sendEmail({ to, subject, html, text, attachments }) {
  if (!transporter) {
    initTransporter();
  }

  if (!transporter) {
    logger.warn('Email not sent (no transporter)', { to, subject });
    return { success: false, reason: 'No transporter' };
  }

  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'D25 Teknologi Pendidikan <noreply@d25teknopendidikan.com>',
      to,
      subject,
      html,
      text,
      attachments
    });

    logger.info('Email sent', { to, subject, messageId: info.messageId });
    return { success: true, messageId: info.messageId };
  } catch (error) {
    logger.error('Email send failed', { to, subject, error: error.message });
    return { success: false, error: error.message };
  }
}

// Order confirmation email
async function sendOrderConfirmation(order) {
  const itemsHtml = order.items.map(item => {
    const sizeFee = Number(item.size_price || 0) || 0;
    const sizeLabel = item.size ? `<div style="font-size: 11px; color: #6c757d; margin-top: 4px;">Ukuran: ${item.size}${sizeFee > 0 ? ` (+ ${formatRupiah(sizeFee)})` : ''}</div>` : '';
    return `
      <tr>
        <td style="padding: 12px; border-bottom: 1px solid #eee;">
          <div>${item.name}</div>
          ${sizeLabel}
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: center;">${item.quantity}</td>
        <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right;">${formatRupiah(item.price)}</td>
        <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right;">${formatRupiah(item.price * item.quantity)}</td>
      </tr>
    `;
  }).join('');

  const vaInfo = order.paymentVaNumber ? `
    <div style="background: #E8F1FA; border: 1px solid #004E8C; border-radius: 8px; padding: 16px; margin: 16px 0;">
      <h3 style="margin: 0 0 12px; color: #002B5C;">Virtual Account BNI</h3>
      <p style="margin: 0 0 8px;"><strong>Nomor VA:</strong> <span style="font-family: monospace; font-size: 18px; font-weight: bold; color: #004E8C;">${order.paymentVaNumber}</span></p>
      <p style="margin: 0;"><strong>Berlaku sampai:</strong> ${order.paymentVaExpiry ? new Date(order.paymentVaExpiry).toLocaleString('id-ID') : '-'}</p>
    </div>
  ` : '';

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #002B5C 0%, #004E8C 100%); color: white; padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
        <h1 style="margin: 0; font-size: 24px;">Konfirmasi Pesanan</h1>
        <p style="margin: 8px 0 0; opacity: 0.9;">D25 Teknologi Pendidikan - Universitas Negeri Malang</p>
      </div>
      
      <div style="background: white; border: 1px solid #E9ECEF; border-radius: 0 0 8px 8px; padding: 30px;">
        <p style="font-size: 16px;">Halo <strong>${order.customer_name}</strong>,</p>
        <p>Terima kasih telah memesan di D25 Teknologi Pendidikan. Pesanan Anda telah kami terima dan sedang diproses.</p>
        
        <div style="background: #F8F9FA; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h3 style="margin: 0 0 16px; color: #002B5C; border-bottom: 2px solid #C8A94E; padding-bottom: 8px;">Detail Pesanan</h3>
          <p><strong>Nomor Pesanan:</strong> ${order.order_number}</p>
          <p><strong>Tanggal:</strong> ${new Date(order.created_at).toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
          <p><strong>Metode Pembayaran:</strong> ${getPaymentMethodLabel(order.payment_method)}</p>
          ${order.payment_id ? `<p><strong>Nomor VA:</strong> <span style="font-family: monospace; font-weight: bold;">${order.payment_id}</span></p>` : ''}
        </div>

        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <thead>
            <tr style="background: #002B5C; color: white;">
              <th style="padding: 12px; text-align: left;">Produk</th>
              <th style="padding: 12px; text-align: center;">Qty</th>
              <th style="padding: 12px; text-align: right;">Harga</th>
              <th style="padding: 12px; text-align: right;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="3" style="padding: 12px; text-align: right; font-weight: bold;">Subtotal</td>
              <td style="padding: 12px; text-align: right;">${formatRupiah(order.subtotal)}</td>
            </tr>
            <tr style="background: #F8F9FA;">
              <td colspan="3" style="padding: 12px; text-align: right; font-weight: bold; font-size: 16px;">Total</td>
              <td style="padding: 12px; text-align: right; font-weight: bold; font-size: 16px; color: #002B5C;">${formatRupiah(order.total)}</td>
            </tr>
          </tfoot>
        </table>

        ${vaInfo}

        <div style="background: #FFF3CD; border: 1px solid #FFC107; border-radius: 8px; padding: 16px; margin: 20px 0;">
          <h4 style="margin: 0 0 12px; color: #856404;">Langkah Selanjutnya</h4>
          <ol style="margin: 0; padding-left: 20px; color: #856404;">
            <li>Lakukan pembayaran melalui ATM, Internet Banking, Mobile Banking, atau minimarket</li>
            <li>Gunakan nomor Virtual Account di atas</li>
            <li>Akses kelas akan dibuka otomatis setelah pembayaran terverifikasi (maks 15 menit)</li>
            <li>Anda akan menerima email notifikasi saat akses sudah tersedia</li>
          </ol>
        </div>

        <hr style="border: none; border-top: 1px solid #E9ECEF; margin: 30px 0;">
        <p style="color: #6C757D; font-size: 14px; text-align: center;">
          Butuh bantuan? Hubungi kami di <a href="mailto:d25teknopendidikan@um.ac.id" style="color: #004E8C;">d25teknopendidikan@um.ac.id</a> atau WhatsApp <a href="https://wa.me/6281234567890" style="color: #004E8C;">+62 812-3456-7890</a>
        </p>
      </div>
    </body>
    </html>
  `;

  const text = `
Konfirmasi Pesanan D25 Teknologi Pendidikan

Nomor Pesanan: ${order.order_number}
Tanggal: ${new Date(order.created_at).toLocaleDateString('id-ID')}
Total: ${formatRupiah(order.total)}

Silakan lakukan pembayaran sesuai instruksi di email HTML.
  `;

  return sendEmail({
    to: order.customer_email,
    subject: `Konfirmasi Pesanan ${order.order_number} - D25 Teknologi Pendidikan`,
    html,
    text
  });
}

// Payment success email
async function sendPaymentSuccess(order) {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #16A34A 0%, #22C55E 100%); color: white; padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
        <h1 style="margin: 0; font-size: 24px;">✓ Pembayaran Berhasil</h1>
        <p style="margin: 8px 0 0; opacity: 0.9;">Pesanan ${order.order_number} telah lunas</p>
      </div>
      
      <div style="background: white; border: 1px solid #E9ECEF; border-radius: 0 0 8px 8px; padding: 30px;">
        <p>Halo <strong>${order.customer_name}</strong>,</p>
        <p>Pembayaran untuk pesanan <strong>${order.order_number}</strong> sebesar <strong>${formatRupiah(order.total)}</strong> telah kami terima dan diverifikasi.</p>
        
        <div style="background: #DCFCE7; border: 1px solid #BBF7D0; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <p style="margin: 0 0 8px;"><strong>Akses kelas sudah dibuka!</strong></p>
          <p style="margin: 0;">Silakan login di <a href="${process.env.APP_URL}" style="color: #004E8C;">${process.env.APP_URL}</a> untuk mulai belajar.</p>
        </div>

        <p>Detail pembayaran:</p>
        <ul>
          <li><strong>Nomor Pesanan:</strong> ${order.order_number}</li>
          <li><strong>Total:</strong> ${formatRupiah(order.total)}</li>
          <li><strong>Waktu Pembayaran:</strong> ${new Date(order.paid_at).toLocaleString('id-ID')}</li>
        </ul>

        <p style="margin-top: 30px;">Selamat belajar di D25 Teknologi Pendidikan!</p>
        
        <hr style="border: none; border-top: 1px solid #E9ECEF; margin: 30px 0;">
        <p style="color: #6C757D; font-size: 14px; text-align: center;">
          D25 Teknologi Pendidikan - Universitas Negeri Malang
        </p>
      </div>
    </body>
    </html>
  `;

  return sendEmail({
    to: order.customer_email,
    subject: `Pembayaran Berhasil - ${order.order_number} - D25 Teknologi Pendidikan`,
    html,
    text: `Pembayaran untuk ${order.order_number} sebesar ${formatRupiah(order.total)} berhasil. Akses kelas sudah dibuka.`
  });
}

// Payment failed/expired email
async function sendPaymentFailed(order, reason = 'expired') {
  const messages = {
    expired: 'Waktu pembayaran telah habis',
    failed: 'Pembayaran gagal diproses',
    cancelled: 'Pesanan dibatalkan'
  };

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #DC2626 0%, #EF4444 100%); color: white; padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
        <h1 style="margin: 0; font-size: 24px;">✗ ${reason === 'expired' ? 'Waktu Habis' : 'Pembayaran Gagal'}</h1>
        <p style="margin: 8px 0 0; opacity: 0.9;">Pesanan ${order.order_number}</p>
      </div>
      
      <div style="background: white; border: 1px solid #E9ECEF; border-radius: 0 0 8px 8px; padding: 30px;">
        <p>Halo <strong>${order.customer_name}</strong>,</p>
        <p>${messages[reason]} untuk pesanan <strong>${order.order_number}</strong>.</p>
        
        <div style="background: #FEF2F2; border: 1px solid #FECACA; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <p style="margin: 0 0 8px;"><strong>Anda tetap bisa memesan ulang:</strong></p>
          <p style="margin: 0;"><a href="${process.env.APP_URL}/checkout" style="display: inline-block; background: #004E8C; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Pesan Ulang Sekarang</a></p>
        </div>

        <p>Jika Anda sudah melakukan pembayaran, silakan hubungi kami dengan bukti transfer.</p>
      </div>
    </body>
    </html>
  `;

  return sendEmail({
    to: order.customer_email,
    subject: `${reason === 'expired' ? 'Waktu Habis' : 'Pembayaran Gagal'} - ${order.order_number} - D25 Teknologi Pendidikan`,
    html,
    text: `${messages[reason]} untuk ${order.order_number}. Silakan pesan ulang di ${process.env.APP_URL}`
  });
}

// Admin notification for new order
async function sendAdminNewOrder(order) {
  const adminEmails = (process.env.ADMIN_EMAILS || process.env.EMAIL_USER).split(',');
  
  const html = `
    <h2>Pesanan Baru: ${order.order_number}</h2>
    <p><strong>Pelanggan:</strong> ${order.customer_name} (${order.customer_email})</p>
    <p><strong>Total:</strong> ${formatRupiah(order.total)}</p>
    <p><strong>Metode:</strong> ${getPaymentMethodLabel(order.payment_method)}</p>
    <p><a href="${process.env.APP_URL}/admin/orders/${order.id}">Lihat di Admin</a></p>
  `;

  return Promise.all(adminEmails.map(email => sendEmail({
    to: email.trim(),
    subject: `Pesanan Baru: ${order.order_number} - ${formatRupiah(order.total)}`,
    html
  })));
}

function formatRupiah(angka) {
  return 'Rp ' + Number(angka).toLocaleString('id-ID');
}

function getPaymentMethodLabel(method) {
  const labels = {
    'midtrans_snap': 'Midtrans (Semua Metode)',
    'bank_bni': 'Virtual Account BNI',
    'bank_bri': 'Virtual Account BRI',
    'bank_permata': 'Virtual Account Permata',
    'bank_transfer': 'Transfer Bank',
    'bri_virtual_account': 'BRI Virtual Account',
    'ewallet': 'E-Wallet'
  };
  return labels[method] || method;
}

module.exports = {
  initTransporter,
  sendEmail,
  sendOrderConfirmation,
  sendPaymentSuccess,
  sendPaymentFailed,
  sendAdminNewOrder
};