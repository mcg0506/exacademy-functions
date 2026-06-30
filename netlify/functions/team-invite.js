// netlify/functions/team-invite.js
// Admin invites team members by email. Validates seat availability,
// creates/updates organisation_members rows with a secure invite token,
// and sends an invite email via the same SMTP setup used for auth emails.
//
// Requires: SUPABASE_URL, SUPABASE_SERVICE_KEY, plus SMTP env vars
// (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM) already
// configured for the Supabase custom email templates.

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

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

const SITE_URL = 'https://exacademy.co.uk';
const INVITE_EXPIRY_DAYS = 14;

function buildTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false, // TLS via STARTTLS, matches existing smtp.ionos.co.uk:587 setup
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function inviteEmailHtml({ inviterName, orgName, inviteUrl }) {
  return `
  <div style="font-family:Arial,sans-serif;background:#0a0f1e;padding:40px 20px;">
    <div style="max-width:520px;margin:0 auto;background:#121929;border:1px solid #2a3a52;border-radius:10px;padding:36px;">
      <div style="display:inline-block;background:#f59e0b;color:#0a0f1e;font-weight:800;font-size:14px;padding:4px 9px;border-radius:4px;margin-bottom:20px;">EX</div>
      <h1 style="color:#ffffff;font-size:22px;margin:0 0 12px;">You've been invited to ${orgName}</h1>
      <p style="color:#94a3b8;font-size:14px;line-height:1.7;margin:0 0 24px;">
        ${inviterName} has invited you to join their team on EX Academy — the hazardous area electrical training platform.
        Accept the invite to get full access to inspection simulations, equipment selection scenarios, and 1,185+ practice questions.
      </p>
      <a href="${inviteUrl}" style="display:inline-block;background:#f59e0b;color:#0a0f1e;font-weight:700;font-size:14px;padding:13px 28px;border-radius:6px;text-decoration:none;">Accept Invite →</a>
      <p style="color:#64748b;font-size:12px;margin-top:24px;">This invite expires in ${INVITE_EXPIRY_DAYS} days. If you weren't expecting this, you can ignore this email.</p>
    </div>
  </div>`;
}

exports.handler = async (event) => {

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  try {
    const { adminUserId, emails, orgId } = JSON.parse(event.body);

    if (!adminUserId || !orgId || !Array.isArray(emails) || emails.length === 0) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing adminUserId, orgId, or emails.' }) };
    }

    // ── Verify the requester owns/admins this organisation ──
    const { data: org, error: orgErr } = await supabase
      .from('organisations')
      .select('id, name, owner_id, seats_purchased')
      .eq('id', orgId)
      .single();

    if (orgErr || !org) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Organisation not found.' }) };
    }

    let isAuthorised = org.owner_id === adminUserId;
    if (!isAuthorised) {
      const { data: adminRow } = await supabase
        .from('organisation_members')
        .select('role, status')
        .eq('organisation_id', orgId)
        .eq('user_id', adminUserId)
        .single();
      isAuthorised = adminRow?.role === 'admin' && adminRow?.status === 'active';
    }

    if (!isAuthorised) {
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not authorised to invite members to this organisation.' }) };
    }

    // ── Check seat availability ──
    const { count: usedSeats } = await supabase
      .from('organisation_members')
      .select('id', { count: 'exact', head: true })
      .eq('organisation_id', orgId)
      .in('status', ['active', 'invited']);

    const cleanEmails = [...new Set(emails.map(e => String(e).trim().toLowerCase()).filter(Boolean))];
    const availableSeats = org.seats_purchased - (usedSeats || 0);

    if (cleanEmails.length > availableSeats) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: `Not enough seats. You have ${availableSeats} seat(s) available but tried to invite ${cleanEmails.length}.`,
        }),
      };
    }

    // ── Get inviter's display name ──
    const { data: inviterProfile } = await supabase
      .from('profiles')
      .select('full_name, email')
      .eq('id', adminUserId)
      .single();
    const inviterName = inviterProfile?.full_name || inviterProfile?.email?.split('@')[0] || 'A team admin';

    const transporter = buildTransport();
    const results = [];

    for (const email of cleanEmails) {
      const token = crypto.randomBytes(24).toString('hex');
      const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

      // Upsert — re-inviting an existing 'invited' row refreshes the token/expiry
      const { error: upsertErr } = await supabase
        .from('organisation_members')
        .upsert({
          organisation_id: orgId,
          email,
          role: 'member',
          status: 'invited',
          invited_at: new Date().toISOString(),
          invite_token: token,
          invite_expires_at: expiresAt,
        }, { onConflict: 'organisation_id,email' });

      if (upsertErr) {
        results.push({ email, sent: false, error: upsertErr.message });
        continue;
      }

      const inviteUrl = `${SITE_URL}/accept-invite.html?token=${token}`;

      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM || 'EX Academy <sales@exacademy.co.uk>',
          to: email,
          subject: `${inviterName} invited you to join ${org.name} on EX Academy ⚡`,
          html: inviteEmailHtml({ inviterName, orgName: org.name, inviteUrl }),
        });
        results.push({ email, sent: true });
      } catch (mailErr) {
        console.error(`Failed to send invite to ${email}:`, mailErr.message);
        results.push({ email, sent: false, error: 'Email delivery failed' });
      }
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ results, seatsRemaining: availableSeats - cleanEmails.length }),
    };

  } catch (err) {
    console.error('Team invite error:', err.message);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
