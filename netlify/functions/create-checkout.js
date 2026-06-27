// netlify/functions/create-checkout.js

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {

  // Handle CORS preflight request
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  try {
    const { plan, userId, userEmail, successUrl, cancelUrl } = JSON.parse(event.body);

    if (!['monthly', 'annual'].includes(plan)) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Invalid plan.' }),
      };
    }

    const priceId = plan === 'monthly'
      ? process.env.MONTHLY_PRICE_ID
      : process.env.ANNUAL_PRICE_ID;

    if (!priceId) {
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Price ID not configured.' }),
      };
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: userEmail,
      client_reference_id: userId,
      metadata: {
        supabase_user_id: userId,
        plan: plan,
      },
      success_url: successUrl || 'https://exacademy.co.uk/dashboard.html?checkout=success',
      cancel_url:  cancelUrl  || 'https://exacademy.co.uk/index.html#pricing',
      allow_promotion_codes: true,
      billing_address_collection: 'required',
    });

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ url: session.url }),
    };

  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
