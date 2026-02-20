require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_your_key_here');
const cors = require('cors');
const admin = require('firebase-admin');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
console.log('Stripe key loaded:', STRIPE_SECRET_KEY ? 'YES' : 'NO');

// Initialize Firebase Admin (for database)
try {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}'))
  });
} catch(e) {
  console.log('Firebase init skipped (need service account)');
}

const app = express();
app.use(cors());
app.use(express.json());

// ==================== STRIPE CONNECT SETUP ====================

// Create connected account for a pool (Stripe Connect)
app.post('/api/connect/create-account', async (req, res) => {
  try {
    const { email, poolName } = req.body;
    
    const account = await stripe.accounts.create({
      type: 'express',
      email: email,
      capabilities: {
        transfers: { requested: true },
        card_payments: { requested: true },
      },
      business_profile: {
        name: poolName,
      },
      metadata: {
        type: 'pool',
      },
    });
    
    res.json({ 
      success: true, 
      accountId: account.id,
      accountLink: await _createAccountLink(account.id)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create account link for onboarding
async function _createAccountLink(accountId) {
  const accountLink = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${process.env.FRONTEND_URL}/reauth`,
    return_url: `${process.env.FRONTEND_URL}/success`,
    type: 'account_onboarding',
  });
  return accountLink.url;
}

// Get account status
app.get('/api/connect/account/:accountId', async (req, res) => {
  try {
    const account = await stripe.accounts.retrieve(req.params.accountId);
    res.json({ 
      success: true, 
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== PAYMENTS ====================

// Create payment intent for deposit
app.post('/api/payments/create-intent', async (req, res) => {
  try {
    const { amount, poolId, currency = 'gbp', userId } = req.body;
    
    // Amount in smallest currency unit (pence for GBP)
    const amountInPence = Math.round(amount * 100);
    
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInPence,
      currency: currency,
      metadata: {
        poolId,
        userId,
        type: 'pool_deposit',
      },
      automatic_payment_methods: {
        enabled: true,
      },
    });
    
    res.json({ 
      success: true, 
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Confirm deposit (webhook would handle this in production)
app.post('/api/payments/confirm-deposit', async (req, res) => {
  try {
    const { paymentIntentId, poolId, userId, amount } = req.body;
    
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    if (paymentIntent.status === 'succeeded') {
      // Update pool balance in database
      // await _updatePoolBalance(poolId, amount);
      
      res.json({ 
        success: true, 
        message: 'Deposit confirmed',
        transactionId: paymentIntent.id 
      });
    } else {
      res.status(400).json({ 
        success: false, 
        error: 'Payment not completed' 
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== WITHDRAWALS ====================

// Request withdrawal from pool
app.post('/api/withdrawals/request', async (req, res) => {
  try {
    const { amount, poolId, userId, bankAccountId, poolStripeAccountId } = req.body;
    
    const amountInPence = Math.round(amount * 100);
    
    // Create transfer to user's connected account
    const transfer = await stripe.transfers.create({
      amount: amountInPence,
      currency: 'gbp',
      destination: poolStripeAccountId,
      metadata: {
        poolId,
        userId,
        type: 'pool_withdrawal',
      },
    });
    
    res.json({ 
      success: true, 
      transferId: transfer.id,
      message: 'Withdrawal initiated' 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== SUBSCRIPTIONS ====================

// Create subscription checkout session
app.post('/api/subscriptions/create-checkout', async (req, res) => {
  try {
    const { userId, priceId, successUrl, cancelUrl } = req.body;
    
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      metadata: {
        userId,
      },
      success_url: successUrl || `${process.env.FRONTEND_URL}/subscription/success`,
      cancel_url: cancelUrl || `${process.env.FRONTEND_URL}/subscription/cancel`,
    });
    
    res.json({ 
      success: true, 
      sessionId: session.id,
      url: session.url 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get subscription status
app.get('/api/subscriptions/:subscriptionId', async (req, res) => {
  try {
    const subscription = await stripe.subscriptions.retrieve(req.params.subscriptionId);
    res.json({ 
      success: true, 
      status: subscription.status,
      currentPeriodEnd: subscription.current_period_end,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== WEBHOK ====================

// Stripe webhook (for production)
app.post('/api/webhooks/stripe', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  // Handle events
  switch (event.type) {
    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      console.log('Payment succeeded:', paymentIntent.id);
      // Update pool balance in database
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      // Handle subscription changes
      break;
    case 'account.updated':
      // Handle connected account updates
      break;
  }
  
  res.json({ received: true });
});

// ==================== HEALTH CHECK ====================

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    stripeVersion: stripe.VERSION 
  });
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FriendPool API running on port ${PORT}`);
  console.log(`Stripe version: ${stripe.VERSION}`);
});
