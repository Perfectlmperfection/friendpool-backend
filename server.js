require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_your_key_here');
const cors = require('cors');
const admin = require('firebase-admin');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
console.log('Stripe key loaded:', STRIPE_SECRET_KEY ? 'YES' : 'NO');

try {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}'))
  });
} catch(e) {
  console.log('Firebase init skipped');
}

const app = express();
app.use(cors());
app.use(express.json());

// ==================== PAYMENTS ====================

// Create payment intent
app.post('/api/payments/create-intent', async (req, res) => {
  try {
    const { amount, poolId, userId, currency = 'gbp' } = req.body;
    const amountInPence = Math.round(amount * 100);
    
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInPence,
      currency: currency,
      metadata: { poolId, userId, type: 'pool_deposit' },
      automatic_payment_methods: { enabled: true },
    });
    
    res.json({ success: true, clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create checkout session for deposits
app.post('/api/payments/create-checkout', async (req, res) => {
  try {
    const { amount, poolId, userId, currency = 'gbp' } = req.body;
    const amountInPence = Math.round(amount * 100);
    
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: currency,
          product_data: { name: 'FriendPool Deposit', description: 'Pool deposit for: ' + poolId },
          unit_amount: amountInPence,
        },
        quantity: 1,
      }],
      metadata: { poolId, userId, type: 'pool_deposit' },
      success_url: 'friendpool://payment-success',
      cancel_url: 'friendpool://payment-cancel',
    });
    
    res.json({ success: true, url: session.url, sessionId: session.id });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Confirm deposit
app.post('/api/payments/confirm-deposit', async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    if (paymentIntent.status === 'succeeded') {
      res.json({ success: true, message: 'Deposit confirmed', transactionId: paymentIntent.id });
    } else {
      res.status(400).json({ success: false, error: 'Payment not completed' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== WITHDRAWALS ====================

app.post('/api/withdrawals/request', async (req, res) => {
  try {
    const { amount, poolStripeAccountId } = req.body;
    const amountInPence = Math.round(amount * 100);
    
    const transfer = await stripe.transfers.create({
      amount: amountInPence,
      currency: 'gbp',
      destination: poolStripeAccountId,
    });
    
    res.json({ success: true, transferId: transfer.id, message: 'Withdrawal initiated' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== SUBSCRIPTIONS ====================

app.post('/api/subscriptions/create-checkout', async (req, res) => {
  try {
    const { userId, priceId } = req.body;
    
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { userId },
      success_url: 'friendpool://subscription-success',
      cancel_url: 'friendpool://subscription-cancel',
    });
    
    res.json({ success: true, sessionId: session.id, url: session.url });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== EMAIL VERIFICATION ====================

const RESEND_API_KEY = process.env.RESEND_API_KEY;
console.log('Resend API Key loaded:', RESEND_API_KEY ? 'YES' : 'NO');

const verificationCodes = new Map();

app.post('/api/auth/send-verification', async (req, res) => {
  try {
    const { email, name, code } = req.body;
    if (!email || !code) return res.status(400).json({ success: false, error: 'Email and code required' });

    verificationCodes.set(email, { code: code, expires: Date.now() + 15 * 60 * 1000 });

    if (RESEND_API_KEY) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify({
          from: 'FriendPool <noreply@friendpoolapp.com>',
          to: email,
          subject: 'Your FriendPool Verification Code',
          html: `<!DOCTYPE html><html><body style="font-family: Arial;"><div style="max-width: 500px; margin: 0 auto; background: #f5f5f5; padding: 30px; border-radius: 10px;"><h2 style="color: #1a73e8;">FriendPool</h2><p>Hi ${name || 'there'},</p><p>Your verification code is:</p><div style="background: white; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;"><span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1a73e8;">${code}</span></div><p style="color: #666;">This code expires in 15 minutes.</p></div></body></html>`
        })
      });

      if (response.ok) {
        console.log('Verification email sent to:', email);
        return res.json({ success: true, message: 'Email sent' });
      }
    }
    res.json({ success: true, message: 'Code generated' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/auth/verify-code', (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ success: false, error: 'Email and code required' });

    const stored = verificationCodes.get(email);
    if (!stored) return res.json({ success: false, error: 'No verification code found' });
    if (Date.now() > stored.expires) { verificationCodes.delete(email); return res.json({ success: false, error: 'Code expired' }); }
    if (stored.code !== code) return res.json({ success: false, error: 'Invalid code' });

    verificationCodes.delete(email);
    return res.json({ success: true, message: 'Email verified' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== HEALTH ====================

app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/api/debug', (req, res) => res.json({ status: 'ok', resendLoaded: !!RESEND_API_KEY }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`FriendPool API running on port ${PORT}`));
