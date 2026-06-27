// netlify/functions/create-checkout.js
// Creates a Stripe Checkout session for Monthly or Annual plan
// Called from the site when user clicks "Start Monthly" or "Go Annual"
//
// Environment variables needed in Netlify:
//   STRIPE_SECRET_KEY      — from Stripe Dashboard → Developers → API Keys
//   MONTHLY_PRICE_ID       — price_xxx from Stripe Monthly Learner product
//   ANNUAL_PRICE_ID        — price_xxx from Stripe Annual Learner product

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // CORS headers — update origin to your live Ionos domain
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  try {
    const { plan, userId, userEmail, successUrl, cancelUrl } = JSON.parse(event.body);

    // Validate plan
    if (!['monthly', 'annual'].includes(plan)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid plan. Must be monthly or annual.' }),
      };
    }

    // Select the correct Stripe price ID
    const priceId = plan === 'monthly'
      ? process.env.MONTHLY_PRICE_ID
      : process.env.ANNUAL_PRICE_ID;

    // Create the Stripe Checkout session
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: userEmail,
      // Pass the Supabase user ID so the webhook can link the subscription
      client_reference_id: userId,
      metadata: {
        supabase_user_id: userId,
        plan: plan,
      },
      success_url: successUrl || 'https://yourdomain.co.uk/dashboard.html?checkout=success',
      cancel_url:  cancelUrl  || 'https://yourdomain.co.uk/index.html#pricing',
      // Allow promotion codes
      allow_promotion_codes: true,
      // Collect billing address for UK VAT compliance
      billing_address_collection: 'required',
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ url: session.url }),
    };

  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
