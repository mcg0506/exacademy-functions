// netlify/functions/stripe-webhook.js
// Receives events from Stripe and updates Supabase subscriptions table.
// Handles two webhook signing secrets (one per Stripe destination).

const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];

  // Try both signing secrets — one for each Stripe webhook destination
  let stripeEvent;
  const secrets = [
    process.env.STRIPE_WEBHOOK_SECRET,
    process.env.STRIPE_WEBHOOK_SECRET_2,
  ].filter(Boolean);

  for (const secret of secrets) {
    try {
      stripeEvent = stripe.webhooks.constructEvent(event.body, sig, secret);
      break; // verified — stop trying
    } catch (err) {
      // try next secret
    }
  }

  if (!stripeEvent) {
    console.error('Webhook signature verification failed for all secrets');
    return { statusCode: 400, body: 'Webhook Error: Invalid signature' };
  }

  try {
    switch (stripeEvent.type) {

      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const userId  = session.metadata?.supabase_user_id;
        const plan    = session.metadata?.plan;

        if (!userId) { console.error('No supabase_user_id in metadata'); break; }

        const stripeSub = await stripe.subscriptions.retrieve(session.subscription);

        await supabase.from('subscriptions').upsert({
          user_id:              userId,
          plan:                 plan,
          status:               'active',
          stripe_customer_id:   session.customer,
          stripe_sub_id:        session.subscription,
          current_period_end:   new Date(stripeSub.current_period_end * 1000).toISOString(),
          cancel_at_period_end: false,
          updated_at:           new Date().toISOString(),
        }, { onConflict: 'user_id' });

        console.log(`Activated: user ${userId} plan ${plan}`);
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = stripeEvent.data.object;
        if (invoice.billing_reason !== 'subscription_cycle') break;

        const stripeSub  = await stripe.subscriptions.retrieve(invoice.subscription);
        const { data: sub } = await supabase
          .from('subscriptions')
          .select('user_id')
          .eq('stripe_customer_id', invoice.customer)
          .single();

        if (sub) {
          await supabase.from('subscriptions').update({
            status:             'active',
            current_period_end: new Date(stripeSub.current_period_end * 1000).toISOString(),
            updated_at:         new Date().toISOString(),
          }).eq('user_id', sub.user_id);
          console.log(`Renewed: user ${sub.user_id}`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const { data: sub } = await supabase
          .from('subscriptions')
          .select('user_id')
          .eq('stripe_customer_id', stripeEvent.data.object.customer)
          .single();

        if (sub) {
          await supabase.from('subscriptions').update({
            status:     'expired',
            updated_at: new Date().toISOString(),
          }).eq('user_id', sub.user_id);
          console.log(`Expired: user ${sub.user_id}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const stripeSub  = stripeEvent.data.object;
        const { data: sub } = await supabase
          .from('subscriptions')
          .select('user_id')
          .eq('stripe_customer_id', stripeSub.customer)
          .single();

        if (sub) {
          await supabase.from('subscriptions').update({
            status:               stripeSub.status === 'active' ? 'active' : stripeSub.status,
            cancel_at_period_end: stripeSub.cancel_at_period_end,
            current_period_end:   new Date(stripeSub.current_period_end * 1000).toISOString(),
            updated_at:           new Date().toISOString(),
          }).eq('user_id', sub.user_id);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const { data: sub } = await supabase
          .from('subscriptions')
          .select('user_id')
          .eq('stripe_customer_id', stripeEvent.data.object.customer)
          .single();

        if (sub) {
          await supabase.from('subscriptions').update({
            status:     'cancelled',
            plan:       'demo',
            updated_at: new Date().toISOString(),
          }).eq('user_id', sub.user_id);
          console.log(`Cancelled: user ${sub.user_id} reverted to demo`);
        }
        break;
      }

      default:
        console.log(`Unhandled event: ${stripeEvent.type}`);
    }

  } catch (err) {
    console.error('Webhook processing error:', err.message);
    return { statusCode: 500, body: 'Internal error' };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
