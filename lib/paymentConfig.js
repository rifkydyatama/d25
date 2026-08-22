// Default payment fees (used as fallback if DB not configured yet)
const defaultPaymentFees = {
  bank_bni:     { name: 'BNI Virtual Account',      type: 'flat',    value: 4000, snapType: 'bank_transfer', active: true },
  bank_bri:     { name: 'BRI Virtual Account',      type: 'flat',    value: 4000, snapType: 'bank_transfer', active: true },
  bank_bca:     { name: 'BCA Virtual Account',      type: 'flat',    value: 4000, snapType: 'bank_transfer', active: true },
  bank_mandiri: { name: 'Mandiri Bill Payment',     type: 'flat',    value: 4000, snapType: 'echannel',      active: true },
  bank_permata: { name: 'Permata Virtual Account',  type: 'flat',    value: 4000, snapType: 'bank_transfer', active: true },
  gopay:        { name: 'GoPay',                    type: 'percent', value: 2,    snapType: 'gopay',         active: true },
  shopeepay:    { name: 'ShopeePay',                type: 'percent', value: 2,    snapType: 'shopeepay',     active: true },
  qris:         { name: 'QRIS',                     type: 'percent', value: 0.7,  snapType: 'qris',          active: true },
  indomaret:    { name: 'Indomaret',                type: 'flat',    value: 5000, snapType: 'indomaret',     active: true },
  alfamart:     { name: 'Alfamart',                 type: 'flat',    value: 5000, snapType: 'alfamart',      active: true },
  credit_card:  { name: 'Kartu Kredit / Debit',     type: 'percent', value: 2.9,  snapType: 'credit_card',   active: true },
};

/**
 * Get payment fees from DB (settings table), fallback to defaults.
 * Call this from request handlers; do NOT call at module load time.
 */
async function getPaymentFees() {
  try {
    const { settingsService } = require('./db');
    const raw = await settingsService.get('payment_fees');
    if (raw) {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      delete parsed.preorder; // Pre-order is a purchase type, not a payment method
      return { ...defaultPaymentFees, ...parsed };
    }
  } catch (e) {
    // DB not available or settings not set yet – use defaults
  }
  return { ...defaultPaymentFees };
}

function calculatePaymentFee(methodConfig, subtotal) {
  if (!methodConfig) return 0;
  if (methodConfig.type === 'flat') return Number(methodConfig.value) || 0;
  if (methodConfig.type === 'percent') return Math.round(subtotal * (Number(methodConfig.value) / 100));
  return 0;
}

module.exports = { defaultPaymentFees, getPaymentFees, calculatePaymentFee };
