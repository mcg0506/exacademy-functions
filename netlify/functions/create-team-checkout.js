// netlify/functions/create-team-checkout.js
// Creates a Stripe Checkout session for a TEAM subscription with a seat quantity.
// On completion, the webhook (stripe-webhook.js) creates the organisation row
// and makes the purchasing user its owner/admin.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const MIN_SEATS = 10;
const MAX_SEATS = 250; // self-serve ceiling — above this, direct to Contact Sales

exports.handler = async (event) => {

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  try {
    const { billingInterval, seats, userId, userEmail, orgName, successUrl, cancelUrl } = JSON.parse(event.body);

    if (!['month', 'year'].includes(billingInterval)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid billing interval.' }) };
    }

    const seatCount = parseInt(seats, 10);
    if (!Number.isInteger(seatCount) || seatCount < MIN_SEATS || seatCount > MAX_SEATS) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: `Seats must be between ${MIN_SEATS} and ${MAX_SEATS}. For larger teams, contact sales.` }),
      };
    }

    if (!userId || !userEmail) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing user details.' }) };
    }

    const priceId = billingInterval === 'month'
      ? process.env.TEAM_MONTHLY_PRICE_ID
      : process.env.TEAM_ANNUAL_PRICE_ID;

    if (!priceId) {
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Team price ID not configured.' }) };
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: seatCount }],
      customer_email: userEmail,
      client_reference_id: userId,
      metadata: {
        supabase_user_id: userId,
        plan: 'team',
        seats: String(seatCount),
        org_name: orgName || `${userEmail.split('@')[0]}'s Team`,
      },
      subscription_data: {
        metadata: {
          supabase_user_id: userId,
          plan: 'team',
          seats: String(seatCount),
        },
      },
      success_url: successUrl || 'https://exacademy.co.uk/team-dashboard.html?checkout=success',
      cancel_url:  cancelUrl  || 'https://exacademy.co.uk/pricing.html',
      allow_promotion_codes: true,
      billing_address_collection: 'required',
    });

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ url: session.url }),
    };

  } catch (err) {
    console.error('Team checkout error:', err.message);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
