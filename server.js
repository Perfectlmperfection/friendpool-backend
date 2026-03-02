// Create checkout session for deposits
app.post('/api/payments/create-checkout', async (req, res) => {
  try {
    const { amount, poolId, userId, currency = 'gbp' } = req.body;
    
    const amountInPence = Math.round(amount * 100);
    
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: currency,
            product_data: {
              name: 'FriendPool Deposit',
              description: 'Pool deposit for pool: ' + poolId,
            },
            unit_amount: amountInPence,
          },
          quantity: 1,
        },
      ],
      metadata: { poolId, userId, type: 'pool_deposit' },
      success_url: 'friendpool://payment-success',
      cancel_url: 'friendpool://payment-cancel',
    });
    
    res.json({ success: true, url: session.url, sessionId: session.id });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
