// netlify/functions/stripe-webhook.js
// Receives events from Stripe (payment success, cancellation, renewal etc.)
// and updates the subscriptions table in Supabase accordingly.
//
// Environment variables needed in Netlify:
//   STRIPE_SECRET_KEY      — Stripe secret key
//   STRIPE_WEBHOOK_SECRET  — from Stripe Dashboard → Webhooks → signing secret
//   SUPABASE_URL           — your Supabase project URL
//   SUPABASE_SERVICE_KEY   — Supabase service role key (NOT the anon key)

const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

// Use the SERVICE ROLE key here — this bypasses RLS so the webhook
// can update any user's subscription row
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];

  let stripeEvent;
  try {
    // Verify the webhook signature — proves it came from Stripe
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  // ── Handle each event type ────────────────────────────────
  try {
    switch (stripeEvent.type) {

      // Payment succeeded — subscription is now active
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const userId  = session.metadata?.supabase_user_id;
        const plan    = session.metadata?.plan; // 'monthly' or 'annual'

        if (!userId) {
          console.error('No supabase_user_id in session metadata');
          break;
        }

        // Get full subscription details from Stripe
        const stripeSub = await stripe.subscriptions.retrieve(session.subscription);

        await supabase.from('subscriptions').upsert({
          user_id:             userId,
          plan:                plan,
          status:              'active',
          stripe_customer_id:  session.customer,
          stripe_sub_id:       session.subscription,
          current_period_end:  new Date(stripeSub.current_period_end * 1000).toISOString(),
          cancel_at_period_end: false,
          updated_at:          new Date().toISOString(),
        }, { onConflict: 'user_id' });

        console.log(`Subscription activated for user ${userId} — plan: ${plan}`);
        break;
      }

      // Subscription renewed successfully
      case 'invoice.payment_succeeded': {
        const invoice = stripeEvent.data.object;
        if (invoice.billing_reason !== 'subscription_cycle') break;

        const stripeSub = await stripe.subscriptions.retrieve(invoice.subscription);
        const customerId = invoice.customer;

        // Find the user by Stripe customer ID
        const { data: sub } = await supabase
          .from('subscriptions')
          .select('user_id, plan')
          .eq('stripe_customer_id', customerId)
          .single();

        if (sub) {
          await supabase.from('subscriptions').update({
            status:             'active',
            current_period_end: new Date(stripeSub.current_period_end * 1000).toISOString(),
            updated_at:         new Date().toISOString(),
          }).eq('user_id', sub.user_id);

          console.log(`Subscription renewed for user ${sub.user_id}`);
        }
        break;
      }

      // Payment failed (renewal)
      case 'invoice.payment_failed': {
        const invoice    = stripeEvent.data.object;
        const customerId = invoice.customer;

        const { data: sub } = await supabase
          .from('subscriptions')
          .select('user_id')
          .eq('stripe_customer_id', customerId)
          .single();

        if (sub) {
          await supabase.from('subscriptions').update({
            status:     'expired',
            updated_at: new Date().toISOString(),
          }).eq('user_id', sub.user_id);

          console.log(`Payment failed — subscription expired for user ${sub.user_id}`);
        }
        break;
      }

      // User cancelled (still active until period end)
      case 'customer.subscription.updated': {
        const stripeSub  = stripeEvent.data.object;
        const customerId = stripeSub.customer;

        const { data: sub } = await supabase
          .from('subscriptions')
          .select('user_id')
          .eq('stripe_customer_id', customerId)
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

      // Subscription fully deleted (after cancellation period ends)
      case 'customer.subscription.deleted': {
        const stripeSub  = stripeEvent.data.object;
        const customerId = stripeSub.customer;

        const { data: sub } = await supabase
          .from('subscriptions')
          .select('user_id')
          .eq('stripe_customer_id', customerId)
          .single();

        if (sub) {
          await supabase.from('subscriptions').update({
            status:     'cancelled',
            plan:       'demo',
            updated_at: new Date().toISOString(),
          }).eq('user_id', sub.user_id);

          console.log(`Subscription cancelled — user ${sub.user_id} reverted to demo`);
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${stripeEvent.type}`);
    }

  } catch (err) {
    console.error('Error processing webhook:', err.message);
    return { statusCode: 500, body: 'Internal error processing webhook' };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
