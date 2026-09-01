// =====================================================
// Midtrans HTTP Notification Handler (shared by server.js & server.production.js)
// Docs: https://docs.midtrans.com/docs/https-notification-webhooks.md
// =====================================================
const crypto = require('crypto');

module.exports = function createMidtransWebhookHandler(deps = {}) {
  const { getAdminDb, sendPaymentSuccessEmail, sendPaymentFailedEmail } = deps;
  const log = deps.log || console;

  return async function handleMidtransNotification(req, res) {
    try {
      const notification = req.body || {};
      log.info('Midtrans Notification', { body: notification });

      const { order_id, transaction_status, fraud_status, payment_type, va_numbers } = notification;

      // Always ACK (200) supaya Midtrans tidak mengulang notifikasi tanpa henti.
      if (!order_id) {
        log.warn('Midtrans notification tanpa order_id', { body: notification });
        return res.status(200).json({ status: 'ok' });
      }

      // Verifikasi signature (opsional, lenient: mismatch hanya dicatat)
      const serverKey = process.env.MIDTRANS_SERVER_KEY || '';
      const { signature_key, status_code, gross_amount } = notification;
      if (signature_key && serverKey) {
        const expected = crypto
          .createHash('sha512')
          .update(`${order_id}${status_code}${gross_amount}${serverKey}`)
          .digest('hex');
        if (expected !== signature_key) {
          log.warn('Midtrans signature mismatch', { orderId: order_id });
        } else {
          log.info('Midtrans signature valid', { orderId: order_id });
        }
      }

      // Dukung order_id ber-suffix pelunasan/DP pre-order: "...-LUNAS-1234" / "...-DP-1234"
      const baseOrderNumber = String(order_id).replace(/-(?:DP|LUNAS)(?:-\d+)?$/i, '');
      const isSettlement = /-LUNAS(?:-\d+)?$/i.test(order_id);

      const adminDb = getAdminDb();
      const { data: order } = await adminDb
        .from('orders')
        .select('*')
        .eq('order_number', baseOrderNumber)
        .single();

      if (!order) {
        log.warn('Order not found for notification', { orderId: order_id, base: baseOrderNumber });
        // Tetap ACK 200 — transaksi uji dashboard / notifikasi lama tidak boleh bikin retry terus.
        return res.status(200).json({ status: 'ok', message: 'order not found (ack)' });
      }


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
              // DP pre-order awal terbayar
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

      log.info('Order updated from notification', {
        orderId: order_id,
        transactionStatus: transaction_status,
        newStatus,
        newPaymentStatus
      });

      // Email pembayaran (opsional, tidak memblokir respons)
      if (sendPaymentSuccessEmail && newPaymentStatus === 'paid' && order.payment_status !== 'paid') {
        sendPaymentSuccessEmail({ ...order, paid_at: updates.paid_at }).catch((e) =>
          log.error('Failed to send payment success email', { error: e.message })
        );
      } else if (sendPaymentFailedEmail && newPaymentStatus === 'failed' && order.payment_status !== 'failed') {
        sendPaymentFailedEmail({ ...order }, 'failed').catch((e) =>
          log.error('Failed to send payment failed email', { error: e.message })
        );
      }

      return res.status(200).json({ status: 'success' });
    } catch (e) {
      log.error('Midtrans Notification error', { error: e.message, stack: e.stack });
      // Jangan biarkan error membuat Midtrans retry: ACK 200 tetap dikirim.
      return res.status(200).json({ status: 'ok' });
    }
  };
};
