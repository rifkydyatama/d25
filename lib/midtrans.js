// Midtrans Integration
// Docs: https://docs.midtrans.com

const midtransClient = require('midtrans-client');

class Midtrans {
  constructor(config = {}) {
    const serverKey = config.serverKey || process.env.MIDTRANS_SERVER_KEY || '';
    const clientKey = config.clientKey || process.env.MIDTRANS_CLIENT_KEY || '';
    
    // Auto-detect production from key prefix or explicit config
    let isProduction = false;
    if (typeof config.isProduction === 'boolean') {
      isProduction = config.isProduction;
    } else if (process.env.MIDTRANS_IS_PRODUCTION === 'true' || process.env.MIDTRANS_IS_PRODUCTION === 'True') {
      isProduction = true;
    } else if (serverKey && !serverKey.startsWith('SB-')) {
      isProduction = true;
    }

    this.core = new midtransClient.CoreApi({
      isProduction,
      serverKey,
      clientKey
    });
    
    this.snap = new midtransClient.Snap({
      isProduction,
      serverKey,
      clientKey
    });
  }

  // Create transaction via Snap (redirect to Midtrans payment page)
  async createSnapTransaction(payload) {
    return await this.snap.createTransaction(payload);
  }

  // Create transaction via Core API (for VA, etc)
  async createCoreTransaction(payload) {
    return await this.core.charge(payload);
  }

  // Get transaction status
  async getStatus(orderId) {
    return await this.core.transaction.status(orderId);
  }

  // Handle notification (callback)
  async handleNotification(notificationJson) {
    return await this.core.transaction.notification(notificationJson);
  }

  // Approve/deny challenge (3DS)
  async approveChallenge(orderId, payload) {
    return await this.core.transaction.approve(orderId, payload);
  }

  // Cancel transaction
  async cancel(orderId) {
    return await this.core.transaction.cancel(orderId);
  }

  // Expire transaction
  async expire(orderId) {
    return await this.core.transaction.expire(orderId);
  }

  // Refund transaction
  async refund(orderId, payload) {
    return await this.core.transaction.refund(orderId, payload);
  }
}

// Build payload for Snap (redirect to Midtrans payment page)
// Validasi dp_amount tersimpan: benar jika mendekati expected (toleransi pembulatan Rp1)
function dpAmountValid(stored, expected) {
  return stored > 0 && Math.abs(stored - expected) <= 1;
}

function buildSnapPayload(order) {
  // Support both DB snake_case fields and mapped camelCase fields
  const orderNumber = order.order_number || order.orderNumber;
  const customerName = order.customer_name || order.name || '';
  const customerEmail = order.customer_email || order.email || '';
  const customerPhone = order.customer_phone || order.phone || '';
  const customerAddress = order.customer_address || order.address || '';
  // Gunakan TOTAL (setelah diskon kupon), bukan subtotal
  const total = Number(order.total || order.subtotal || 0);
  const items = order.order_items || order.items || [];

  const firstName = customerName.split(' ')[0];
  const lastName = customerName.split(' ').slice(1).join('') || '';

  // If Pre-Order with DP, charge DP amount + fee
  const isPreorder = order.is_preorder || order.isPreorder;
  const dpPercent = Number(order.dp_percentage || order.dpPercentage || 50);
  const storedDp = Number(order.dp_amount || order.dpAmount || 0);
  const expectedDp = Math.round(total * (dpPercent / 100));
  // dp_amount tersimpan mungkin dihitung dari subtotal (sebelum diskon) oleh versi lama;
  // hitung ulang dari total jika nilainya tidak konsisten
  const dpAmount = (isPreorder && dpAmountValid(storedDp, expectedDp)) ? storedDp : (isPreorder ? expectedDp : 0);
  const paymentFee = order.paymentFee || order.payment_fee || 0;
  const paymentFeeLabel = order.paymentMethodConfig?.name ? `Biaya Layanan (${order.paymentMethodConfig.name})` : 'Biaya Layanan';

  let itemDetails = [];
  let grossAmount = total + paymentFee;

  if (isPreorder && dpAmount > 0) {
    grossAmount = dpAmount + paymentFee;
    itemDetails.push({
      id: `DP-${orderNumber}`,
      price: dpAmount,
      quantity: 1,
      name: `DP Pre-Order (${dpPercent}%) - ${orderNumber}`.substring(0, 50)
    });
    if (paymentFee > 0) {
      itemDetails.push({
        id: 'admin_fee',
        price: paymentFee,
        quantity: 1,
        name: paymentFeeLabel
      });
    }
  } else {
    // Regular full payment
    itemDetails = items.map(item => ({
      id: (item.product_id || item.id || '').toString(),
      price: item.unit_price || item.price || 0,
      quantity: item.quantity || 1,
      name: (item.product_name || item.name || 'Produk').substring(0, 50)
    }));

    if (itemDetails.length === 0) {
      itemDetails.push({
        id: orderNumber,
        price: total,
        quantity: 1,
        name: `Tagihan D25 - ${orderNumber}`.substring(0, 50)
      });
    }

    // Jika ada diskon kupon, tambahkan sebagai baris negatif agar
    // jumlah item_details == gross_amount (syarat validasi Midtrans)
    const itemsSum = itemDetails.reduce((s, it) => s + it.price * it.quantity, 0);
    const discountLine = itemsSum - total;
    if (discountLine > 0) {
      itemDetails.push({
        id: 'DISKON',
        price: -discountLine,
        quantity: 1,
        name: 'Diskon Kupon'
      });
    }

    if (paymentFee > 0) {
      itemDetails.push({
        id: 'admin_fee',
        price: paymentFee,
        quantity: 1,
        name: paymentFeeLabel
      });
    }
  }

  // Determine enabled payments
  let enabledPayments = [
    'bank_transfer', 'echannel', 'credit_card', 'gopay', 'shopeepay', 'indomaret', 'alfamart'
  ];
  if (order.paymentMethodConfig?.snapType) {
    enabledPayments = [order.paymentMethodConfig.snapType];
  }

  return {
    transaction_details: {
      order_id: orderNumber,
      gross_amount: grossAmount
    },
    customer_details: {
      first_name: firstName,
      last_name: lastName,
      email: customerEmail,
      phone: customerPhone,
      billing_address: {
        first_name: firstName,
        last_name: lastName,
        email: customerEmail,
        phone: customerPhone,
        address: customerAddress
      },
      shipping_address: {
        first_name: firstName,
        last_name: lastName,
        email: customerEmail,
        phone: customerPhone,
        address: customerAddress
      }
    },
    item_details: itemDetails,
    enabled_payments: enabledPayments,
    credit_card: {
      secure: true,
      installment: {
        required: false,
        terms: {
          bni: [3, 6, 12],
          mandiri: [3, 6, 12],
          bri: [3, 6, 12]
        }
      }
    },
    echannel: {
      bill_info1: 'Pembayaran D25',
      bill_info2: orderNumber
    },
    callbacks: {
      finish: `${process.env.APP_URL}/order-success`,
      error: `${process.env.APP_URL}/checkout?error=payment_failed`,
      pending: `${process.env.APP_URL}/order-success?status=pending`
    }
  };
}

// Build payload for Core API (VA via bank_transfer)
function buildCoreVAPayload(order, bank = 'bni') {
  // Support both DB snake_case fields and mapped camelCase fields
  const orderNumber = order.order_number || order.orderNumber;
  const customerName = order.customer_name || order.name || '';
  const customerEmail = order.customer_email || order.email || '';
  const customerPhone = order.customer_phone || order.phone || '';
  const total = order.total || 0;
  const items = order.order_items || order.items || [];

  const firstName = customerName.split(' ')[0];
  const lastName = customerName.split(' ').slice(1).join(' ') || '';

  const itemDetails = items.map(item => ({
    id: (item.product_id || item.id || '').toString(),
    price: item.unit_price || item.price || 0,
    quantity: item.quantity || 1,
    name: (item.product_name || item.name || 'Produk').substring(0, 50)
  }));

  const paymentFee = order.paymentFee || order.payment_fee || 0;
  const baseAmount = order.is_preorder || order.isPreorder ? (order.dp_amount || order.dpAmount || 0) : total;
  const grossAmount = baseAmount + paymentFee;

  if (itemDetails.length === 0) {
    itemDetails.push({
      id: orderNumber,
      price: total,
      quantity: 1,
      name: `Tagihan D25 - ${orderNumber}`.substring(0, 50)
    });
  }

  if (paymentFee > 0) {
    itemDetails.push({
      id: 'admin_fee',
      price: paymentFee,
      quantity: 1,
      name: order.paymentMethodConfig?.name ? `Biaya Layanan (${order.paymentMethodConfig.name})` : 'Biaya Layanan'
    });
  }

  return {
    payment_type: 'bank_transfer',
    transaction_details: {
      order_id: orderNumber,
      gross_amount: grossAmount
    },
    customer_details: {
      first_name: firstName,
      last_name: lastName,
      email: customerEmail,
      phone: customerPhone
    },
    item_details: itemDetails,
    bank_transfer: {
      bank: bank,
      va_number: orderNumber.replace('D25-', '')
    }
  };
}

module.exports = { Midtrans, buildSnapPayload, buildCoreVAPayload };