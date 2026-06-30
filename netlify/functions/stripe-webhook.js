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

        // ── TEAM plan: create the organisation, make purchaser the owner ──
        if (plan === 'team') {
          const seats = parseInt(session.metadata?.seats || '10', 10);
          const orgName = session.metadata?.org_name || 'My Team';

          const { data: existingOrg } = await supabase
            .from('organisations')
            .select('id')
            .eq('stripe_subscription_id', session.subscription)
            .maybeSingle();

          let orgId = existingOrg?.id;

          if (!existingOrg) {
            const { data: newOrg, error: orgErr } = await supabase
              .from('organisations')
              .insert({
                name: orgName,
                owner_id: userId,
                stripe_customer_id: session.customer,
                stripe_subscription_id: session.subscription,
                seats_purchased: seats,
                plan_status: 'active',
                billing_interval: stripeSub.items.data[0]?.price?.recurring?.interval || 'month',
              })
              .select('id')
              .single();

            if (orgErr) { console.error('Failed to create organisation:', orgErr.message); break; }
            orgId = newOrg.id;
          }

          // Owner is also an active member with admin role (counts toward seats)
          await supabase.from('organisation_members').upsert({
            organisation_id: orgId,
            user_id: userId,
            email: session.customer_email || session.customer_details?.email,
            role: 'admin',
            status: 'active',
            joined_at: new Date().toISOString(),
          }, { onConflict: 'organisation_id,email' });

          // Owner also gets a personal 'team' subscription row so isPaid() checks pass
          await supabase.from('subscriptions').upsert({
            user_id: userId,
            plan: 'team',
            status: 'active',
            stripe_customer_id: session.customer,
            stripe_sub_id: session.subscription,
            current_period_end: new Date(stripeSub.current_period_end * 1000).toISOString(),
            cancel_at_period_end: false,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'user_id' });

          console.log(`Team created: org ${orgId}, owner ${userId}, ${seats} seats`);
          break;
        }

        // ── Individual monthly/annual plan (existing behaviour) ──
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

        // Sync organisation row if this is a team subscription
        const { data: org } = await supabase
          .from('organisations')
          .select('id')
          .eq('stripe_subscription_id', stripeSub.id)
          .maybeSingle();

        if (org) {
          const newSeatCount = stripeSub.items?.data[0]?.quantity;
          await supabase.from('organisations').update({
            plan_status: stripeSub.status === 'active' ? 'active' : stripeSub.status,
            ...(newSeatCount ? { seats_purchased: newSeatCount } : {}),
            updated_at: new Date().toISOString(),
          }).eq('id', org.id);
          console.log(`Team org ${org.id} synced — status ${stripeSub.status}, seats ${newSeatCount}`);
        }

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
        const stripeSub = stripeEvent.data.object;

        // If this was a team subscription, deactivate the org and all its members
        const { data: org } = await supabase
          .from('organisations')
          .select('id')
          .eq('stripe_subscription_id', stripeSub.id)
          .maybeSingle();

        if (org) {
          await supabase.from('organisations').update({
            plan_status: 'canceled',
            updated_at: new Date().toISOString(),
          }).eq('id', org.id);

          // Revert every active member's personal subscription to demo
          const { data: members } = await supabase
            .from('organisation_members')
            .select('user_id')
            .eq('organisation_id', org.id)
            .eq('status', 'active');

          if (members?.length) {
            const userIds = members.map(m => m.user_id).filter(Boolean);
            await supabase.from('subscriptions')
              .update({ status: 'cancelled', plan: 'demo', updated_at: new Date().toISOString() })
              .in('user_id', userIds);
          }
          console.log(`Team org ${org.id} cancelled — ${members?.length || 0} members reverted to demo`);
        }

        const { data: sub } = await supabase
          .from('subscriptions')
          .select('user_id')
          .eq('stripe_customer_id', stripeSub.customer)
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
