// netlify/functions/ask.js
// Proxies requests from ask-instructor.html to the Anthropic API.
// The API key never touches the browser — it lives here as an env var.
//
// Environment variables needed in Netlify:
//   ANTHROPIC_API_KEY  — from console.anthropic.com
//   SUPABASE_URL       — your Supabase project URL
//   SUPABASE_SERVICE_KEY — Supabase service role key

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SYSTEM_PROMPT = `You are an expert hazardous area electrical instructor for EX Academy, an online training platform for hazardous area electrical professionals. You are deeply knowledgeable about:

- IEC 60079 standard series (all parts) — Ex d, Ex e, Ex i, Ex ia, Ex ib, Ex p, Ex px, Ex pz, Ex t, Ex n, Ex nA, Ex ec, Ex o, Ex q, Ex m
- ATEX Directive and IECEx certification systems
- CompEx scheme — Ex01, Ex02, Ex03, Ex04 competency units
- Zone classification (Zone 0, 1, 2 for gas; Zone 20, 21, 22 for dust; EPL Ga, Gb, Gc, Da, Db, Dc)
- Gas groups (IIA, IIB, IIC), T-classes (T1–T6), MESG values
- Flamepath design, gap limits (IEC 60079-1 Table 1), flamepath dimensions
- Ex d flameproof inspection — missing bolts, bolt grades, barrier glands, flamepath measurement
- Ex e increased safety — IP ratings, terminal requirements, conductor exposure (1mm max), ferrules
- Intrinsic safety (IS) — entity parameters, Zener barriers, galvanic isolators, IS earth, cable segregation
- Ex p pressurisation — pre-purge (5x volume), pressure interlocks, door interlocks
- Ex t dust protection — IP66 requirement, dust group IIIA/IIIB/IIIC, T-class for dust
- IEC 60079-17 inspection — Visual, Close, Detailed grades; Category X, A, B, C deficiencies
- Cable and wiring — SWA armoured cable, barrier vs non-barrier glands, minimum thread engagement (5 full turns metric)
- Gland accessory rules: Ex d threaded (no IP washer, no locknut); Ex e threaded (nylon IP washer always); clearance entries (nylon IP washer + serrated washer + locknut); polyester body no continuity plate (banjo earth tag per cable gland + 6mm² links); polyester with continuity plate (internal serrated washer + locknut + one banjo)
- Equipment selection — matching zone, EPL, gas group, T-class to area classification
- Safe isolation, permit to work, gas-free certificates in hazardous areas
- CompEx assessment preparation

IMPORTANT RULES:
1. ONLY answer questions about hazardous area electrical work, IEC 60079, CompEx preparation, and directly related topics.
2. If someone asks about anything unrelated (general life, other subjects, politics, cooking, relationships, general electrical work outside hazardous areas), politely decline and redirect to hazardous area topics.
3. Be accurate and cite the relevant IEC standard, clause, or table where appropriate.
4. Keep answers clear and educational — suitable for someone preparing for a CompEx assessment.
5. Give practical real-world examples where relevant.
6. Never make up standard references — if unsure of a specific clause number, say so.
7. Format responses clearly with headers or bullet points where helpful.
8. Maintain a professional, instructor tone at all times.`;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method Not Allowed' };
  }

  try {
    const { messages, userId } = JSON.parse(event.body);

    // Optional: verify user has an active subscription before allowing AI use
    // Remove this block if you want AI available to demo users too
    if (userId) {
      const { data: sub } = await supabase
        .from('subscriptions')
        .select('plan, status')
        .eq('user_id', userId)
        .single();

      if (!sub || sub.status !== 'active' || sub.plan === 'demo') {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'AI Instructor is available on paid plans only.' }),
        };
      }
    }

    // Call Anthropic API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 1024,
        system:     SYSTEM_PROMPT,
        messages:   messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || 'Anthropic API error');
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ content: data.content }),
    };

  } catch (err) {
    console.error('AI proxy error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to reach AI instructor. Please try again.' }),
    };
  }
};
