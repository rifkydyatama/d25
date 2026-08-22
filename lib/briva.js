// BRI Virtual Account (BRIVA) Integration
// Docs: https://developers.bri.co.id/en/docs/virtual-accountbriva-online

const crypto = require('crypto');

class BRIVA {
  constructor(config) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.baseUrl = config.isProduction 
      ? 'https://api.bri.co.id' 
      : 'https://sandbox.bri.co.id';
    this.merchantId = config.merchantId;
    this.callbackUrl = config.callbackUrl;
  }

  // Generate signature for authentication
  generateSignature(httpMethod, endpoint, timestamp, body = '') {
    const stringToSign = `${httpMethod}:${endpoint}:${timestamp}:${body}`;
    return crypto
      .createHmac('sha512', this.clientSecret)
      .update(stringToSign)
      .digest('hex')
      .toUpperCase();
  }

  // Get access token
  async getAccessToken() {
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const endpoint = '/v1/auth/token';
    const body = '';
    
    const signature = this.generateSignature('POST', endpoint, timestamp, body);
    
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TIMESTAMP': timestamp,
        'X-CLIENT-KEY': this.clientId,
        'X-SIGNATURE': signature
      },
      body: JSON.stringify({})
    });
    
    const data = await response.json();
    if (data.responseCode !== '200') {
      throw new Error(`Auth failed: ${data.responseMessage}`);
    }
    this.accessToken = data.accessToken;
    return this.accessToken;
  }

  // Create Virtual Account
  async createVA(payload) {
    if (!this.accessToken) await this.getAccessToken();
    
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const endpoint = '/v1/briva/va';
    const body = JSON.stringify(payload);
    
    const signature = this.generateSignature('POST', endpoint, timestamp, body);
    
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
        'X-TIMESTAMP': timestamp,
        'X-CLIENT-KEY': this.clientId,
        'X-SIGNATURE': signature,
        'CHANNEL-ID': '99'
      },
      body
    });
    
    const data = await response.json();
    if (data.responseCode !== '200') {
      throw new Error(`Create VA failed: ${data.responseMessage}`);
    }
    return data;
  }

  // Inquiry VA status
  async inquiryVA(vaNumber) {
    if (!this.accessToken) await this.getAccessToken();
    
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const endpoint = `/v1/briva/va/${vaNumber}`;
    const body = '';
    
    const signature = this.generateSignature('GET', endpoint, timestamp, body);
    
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'X-TIMESTAMP': timestamp,
        'X-CLIENT-KEY': this.clientId,
        'X-SIGNATURE': signature,
        'CHANNEL-ID': '99'
      }
    });
    
    const data = await response.json();
    if (data.responseCode !== '200') {
      throw new Error(`Inquiry failed: ${data.responseMessage}`);
    }
    return data;
  }

  // Update VA (extend expiry, change amount, etc)
  async updateVA(vaNumber, payload) {
    if (!this.accessToken) await this.getAccessToken();
    
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const endpoint = `/v1/briva/va/${vaNumber}`;
    const body = JSON.stringify(payload);
    
    const signature = this.generateSignature('PUT', endpoint, timestamp, body);
    
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
        'X-TIMESTAMP': timestamp,
        'X-CLIENT-KEY': this.clientId,
        'X-SIGNATURE': signature,
        'CHANNEL-ID': '99'
      },
      body
    });
    
    const data = await response.json();
    if (data.responseCode !== '200') {
      throw new Error(`Update VA failed: ${data.responseMessage}`);
    }
    return data;
  }

  // Delete VA
  async deleteVA(vaNumber) {
    if (!this.accessToken) await this.getAccessToken();
    
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const endpoint = `/v1/briva/va/${vaNumber}`;
    const body = '';
    
    const signature = this.generateSignature('DELETE', endpoint, timestamp, body);
    
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'X-TIMESTAMP': timestamp,
        'X-CLIENT-KEY': this.clientId,
        'X-SIGNATURE': signature,
        'CHANNEL-ID': '99'
      }
    });
    
    const data = await response.json();
    if (data.responseCode !== '200') {
      throw new Error(`Delete VA failed: ${data.responseMessage}`);
    }
    return data;
  }

  // Verify callback signature
  verifyCallback(headers, body) {
    const signature = headers['x-signature'];
    const timestamp = headers['x-timestamp'];
    const clientKey = headers['x-client-key'];
    
    // Recreate signature
    const expectedSignature = this.generateSignature('POST', '/callback', timestamp, JSON.stringify(body));
    
    return signature === expectedSignature;
  }
}

// Payment payload builder
function buildCreateVAPayload(order) {
  const expiredDate = new Date();
  expiredDate.setHours(expiredDate.getHours() + 24); // 24 jam
  
  return {
    partnerServiceId: 'BRIVA', // or custom
    customerNo: order.orderNumber.replace('D25-', ''), // unique per order
    virtualAccount: {
      trxId: order.orderNumber,
      trxAmount: order.total,
      trxDescription: `Pembayaran Kelas D25 - ${order.items.map(i => i.name).join(', ')}`,
      expiredDate: expiredDate.toISOString().slice(0, 19).replace('T', ' '),
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      customerPhone: order.customerPhone
    }
  };
}

module.exports = { BRIVA, buildCreateVAPayload };