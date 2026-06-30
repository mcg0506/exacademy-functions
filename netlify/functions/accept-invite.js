// netlify/functions/accept-invite.js
// Called from accept-invite.html once the invitee is signed in (or has just
// signed up). Validates the invite token, checks it hasn't expired, checks
// the signed-in user's email matches the invited email, then marks the
// membership row active and links it to their user_id.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  try {
    const { token, userId, userEmail } = JSON.parse(event.body);

    if (!token || !userId || !userEmail) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing token, userId, or userEmail.' }) };
    }

    const { data: member, error: findErr } = await supabase
      .from('organisation_members')
      .select('id, organisation_id, email, status, invite_expires_at')
      .eq('invite_token', token)
      .single();

    if (findErr || !member) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invite not found or already used.' }) };
    }

    if (member.status === 'active') {
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ alreadyActive: true, organisationId: member.organisation_id }) };
    }

    if (member.status === 'removed') {
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'This invite has been revoked.' }) };
    }

    if (new Date(member.invite_expires_at) < new Date()) {
      return { statusCode: 410, headers: CORS_HEADERS, body: JSON.stringify({ error: 'This invite has expired. Ask your team admin to resend it.' }) };
    }

    if (member.email.toLowerCase() !== userEmail.toLowerCase()) {
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: `This invite was sent to ${member.email}. Please sign in with that email address.` }),
      };
    }

    // ── Activate membership ──
    const { error: updateErr } = await supabase
      .from('organisation_members')
      .update({
        user_id: userId,
        status: 'active',
        joined_at: new Date().toISOString(),
        invite_token: null, // burn the token — single use
      })
      .eq('id', member.id);

    if (updateErr) {
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: updateErr.message }) };
    }

    // ── Grant the user team-level platform access by upserting their subscription ──
    // This ensures the same isPaid()/plan checks used across simulators recognise
    // team members as having full access for as long as the org subscription is active.
    const { data: org } = await supabase
      .from('organisations')
      .select('plan_status')
      .eq('id', member.organisation_id)
      .single();

    await supabase.from('subscriptions').upsert({
      user_id: userId,
      plan: 'team',
      status: org?.plan_status === 'active' ? 'active' : 'inactive',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: true, organisationId: member.organisation_id }),
    };

  } catch (err) {
    console.error('Accept invite error:', err.message);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
