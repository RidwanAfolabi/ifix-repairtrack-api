/**
 * notify.js — DROP THIS INTO THE repair-bot-worker REPO (next to bot.js, db.js,
 * whatsapp.js). It lives here only so it sits alongside the API that calls it;
 * this file is NOT imported by the RepairTrack Worker.
 *
 * Adds POST /notify, letting RepairTrack ask Alia to send a status-update
 * WhatsApp message. RepairTrack never talks to the Meta API itself — this
 * Worker owns WA_TOKEN and the customer conversation.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE 24-HOUR WINDOW — why there are two modes
 *
 * Meta only allows FREE-FORM messages within 24 hours of the customer's last
 * inbound message. Outside that window a free-form send fails with error
 * 131047, and a status update days after intake is almost always outside it.
 * Only an approved TEMPLATE can be delivered outside the window.
 *
 *   WA_NOTIFY_MODE = "template"  (default, recommended)
 *       Sends the approved template. Works at any time. Requires the template
 *       to exist and be APPROVED in Meta — see META_TEMPLATE_SETUP.md.
 *
 *   WA_NOTIFY_MODE = "freeform"
 *       Sends a rich, natural message in Alia's voice. Richer copy and no Meta
 *       approval needed, but ONLY delivers inside the 24h window. Useful while
 *       the app is still under review. A 131047 failure is reported clearly so
 *       staff know to fall back to the manual share.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * WIRING (3 edits to repair-bot-worker/src/index.js):
 *
 *   1. import { handleNotify } from './notify.js';
 *
 *   2. Inside fetch(), BEFORE the `if (url.pathname !== '/webhook')` guard —
 *      that guard 404s everything else, so /notify must be matched above it:
 *
 *        if (url.pathname === '/notify' && request.method === 'POST') {
 *          return handleNotify(request, env);
 *        }
 *
 *   3. Set the shared secret on BOTH workers:
 *        npx wrangler secret put REPAIRTRACK_NOTIFY_SECRET
 *
 * OPTIONAL vars (wrangler.jsonc "vars" on repair-bot-worker):
 *        WA_NOTIFY_MODE          "template" | "freeform"   (default "template")
 *        WA_STATUS_TEMPLATE_NAME default "repair_status_update"
 *        WA_TEMPLATE_LANG        default "ms"
 *        REPAIR_CARD_BASE_URL    default "https://app.ifixexpress.com.my"
 *
 * SECURITY: this endpoint sends WhatsApp messages from the business number.
 * Without the shared secret, anyone who found the bot's URL could message
 * customers from your verified number. It is mandatory — the handler refuses
 * to run if it is not configured.
 */

import { sendTextMessage } from './whatsapp.js';
import { saveMessage }     from './db.js';

const GRAPH_VERSION = 'v21.0';

const DEFAULTS = {
  templateName: 'repair_status_update',
  templateLang: 'ms',
  repairCardBase: 'https://app.ifixexpress.com.my',
};

/** Statuses RepairTrack may send. Anything else is rejected. */
const VALID_STATUSES = [
  'received', 'diagnosing', 'awaiting_parts', 'in_progress',
  'quality_check', 'ready_for_collection', 'collected',
];

/**
 * FREE-FORM copy per status, in Alia's usual Malay/English voice.
 * Used only when WA_NOTIFY_MODE = "freeform".
 *
 * RepairTrack deliberately sends only `status` + `status_label` and never
 * message wording, so all phrasing lives here and can be changed without
 * touching the API.
 */
const STATUS_MESSAGES = {
  received: (d) =>
    `Hi ${d.customer_name}! 👋\n\nPeranti *${d.device_model}* you dah kami terima di ${d.branch_name}.\n\nNo. Job: *${d.job_id}*\n\nBoleh track status repair you bila-bila masa kat sini:\n${d.repair_card_url}`,

  diagnosing: (d) =>
    `Hi ${d.customer_name}! 🔍\n\nTeknisian kami tengah check *${d.device_model}* you sekarang untuk kenal pasti masalah.\n\nKami update you lepas siap diagnose ya!\n\nTrack: ${d.repair_card_url}`,

  awaiting_parts: (d) =>
    `Hi ${d.customer_name}! 📦\n\nUntuk baiki *${d.device_model}* you, kami tengah tunggu spare part sampai.\n\nKami akan sambung kerja sebaik je part tu tiba, dan update you terus.\n\nTrack: ${d.repair_card_url}`,

  in_progress: (d) =>
    `Hi ${d.customer_name}! 🔧\n\nGood news — repair untuk *${d.device_model}* you dah bermula!\n\nKami update lagi bila dah siap ya.\n\nTrack: ${d.repair_card_url}`,

  quality_check: (d) =>
    `Hi ${d.customer_name}! ✅\n\nRepair *${d.device_model}* you dah siap, sekarang tengah quality check untuk pastikan semua berfungsi elok.\n\nHampir siap!\n\nTrack: ${d.repair_card_url}`,

  ready_for_collection: (d) =>
    `Hi ${d.customer_name}! 🎉\n\n*${d.device_model}* you dah SIAP dan boleh diambil di ${d.branch_name}!\n\nNo. Job: *${d.job_id}*\n\nSila bawa no. job ni masa datang ambil ya.\n\nDetails: ${d.repair_card_url}`,

  collected: (d) =>
    `Hi ${d.customer_name}! 🙏\n\nTerima kasih sebab guna khidmat iFix Express!\n\n*${d.device_model}* you dah diambil. Waranti repair you bermula hari ni.\n\nSimpan link ni untuk rujukan waranti:\n${d.repair_card_url}\n\nAda apa-apa masalah, just WhatsApp kami ya!`,
};

/** Constant-time string comparison — avoids leaking the secret via timing. */
function secretsMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (body, status) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * Meta rejects template parameters containing newlines, tabs, or more than
 * four consecutive spaces, and rejects empty parameters outright. Collapse
 * whitespace and substitute a placeholder rather than letting the whole send
 * fail on a stray line break in a staff note.
 */
function cleanParam(value, fallback = '-') {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s === '' ? fallback : s.slice(0, 1000);
}

/**
 * Send an approved template message.
 * Self-contained Graph API call so no edits to whatsapp.js are needed —
 * it reuses the WA_TOKEN / WA_PHONE_NUMBER_ID secrets already configured.
 *
 * Component order and the button index MUST match the approved template.
 * See META_TEMPLATE_SETUP.md for the exact template this expects.
 */
async function sendTemplateMessage(to, payload, env) {
  const name = env.WA_STATUS_TEMPLATE_NAME || DEFAULTS.templateName;
  const lang = env.WA_TEMPLATE_LANG || DEFAULTS.templateLang;

  const bodyParams = [
    cleanParam(payload.customer_name),   // {{1}} name
    cleanParam(payload.device_model),    // {{2}} device
    cleanParam(payload.job_id),          // {{3}} job id
    cleanParam(payload.status_label),    // {{4}} status
    cleanParam(payload.branch_name),     // {{5}} branch
  ];

  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${env.WA_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'template',
        template: {
          name,
          language: { code: lang },
          components: [
            {
              type: 'body',
              parameters: bodyParams.map((text) => ({ type: 'text', text })),
            },
            {
              // Dynamic URL button: Meta appends this to the template's static
              // base, giving .../track/IFX-00001
              type: 'button',
              sub_type: 'url',
              index: '0',
              parameters: [{ type: 'text', text: cleanParam(payload.job_id) }],
            },
          ],
        },
      }),
    },
  );

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = data?.error ?? {};
    const detail = `${err.code ?? res.status}: ${err.message ?? 'unknown error'}`;

    // 132001 = template does not exist / not approved in this language.
    if (err.code === 132001) {
      throw new Error(
        `Template "${name}" (${lang}) not found or not approved. ${detail}`,
      );
    }
    throw new Error(`Template send failed — ${detail}`);
  }

  return data;
}

/**
 * POST /notify
 *
 * Body (from RepairTrack src/services/notify.ts):
 *   { type, status, status_label, customer_whatsapp, customer_name,
 *     device_model, job_id, branch_name, repair_card_url, staff_note? }
 */
export async function handleNotify(request, env) {
  // ── Auth ────────────────────────────────────────────────────────────────
  if (!env.REPAIRTRACK_NOTIFY_SECRET) {
    console.error('[Notify] REPAIRTRACK_NOTIFY_SECRET not set — refusing to send');
    return json({ error: 'Notify endpoint not configured' }, 503);
  }

  if (!secretsMatch(request.headers.get('X-RepairTrack-Secret'), env.REPAIRTRACK_NOTIFY_SECRET)) {
    console.error('[Notify] Rejected request with bad or missing secret');
    return json({ error: 'Unauthorized' }, 401);
  }

  // ── Parse & validate ────────────────────────────────────────────────────
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return json({ error: 'Body must be a JSON object' }, 400);
  }

  const { type, status, customer_whatsapp, customer_name, job_id } = payload;

  if (type !== 'status_update') {
    return json({ error: `Unsupported notification type: ${type}` }, 400);
  }
  if (!customer_whatsapp || !customer_name || !job_id || !status) {
    return json({ error: 'Missing required fields' }, 400);
  }
  if (!VALID_STATUSES.includes(status)) {
    console.error(`[Notify] Unknown status '${status}' for ${job_id}`);
    return json({ error: `Unknown status: ${status}` }, 400);
  }

  // RepairTrack always sends repair_card_url, but derive a fallback so a
  // partial payload still produces a usable message.
  const repairCardUrl =
    payload.repair_card_url ||
    `${(env.REPAIR_CARD_BASE_URL || DEFAULTS.repairCardBase).replace(/\/$/, '')}/track/${job_id}`;

  const mode = (env.WA_NOTIFY_MODE || 'template').toLowerCase();

  // ── Send ────────────────────────────────────────────────────────────────
  let historyText;

  if (mode === 'freeform') {
    // Works ONLY inside the 24h customer service window.
    let text = STATUS_MESSAGES[status]({ ...payload, repair_card_url: repairCardUrl });
    if (payload.staff_note) {
      text += `\n\n📝 _Nota dari teknisian:_\n"${payload.staff_note}"`;
    }

    try {
      await sendTextMessage(customer_whatsapp, text, env);
      historyText = text;
      console.log(`[Notify] Sent free-form '${status}' for ${job_id}`);
    } catch (err) {
      const message = err?.message ?? String(err);
      // 131047 = outside the 24h window; the only fix is a template.
      const outsideWindow = message.includes('131047');
      console.error(
        `[Notify] Free-form send failed for ${job_id}: ${message}` +
          (outsideWindow ? ' — outside 24h window, switch WA_NOTIFY_MODE to "template"' : ''),
      );
      return json(
        {
          error: outsideWindow
            ? 'Outside the 24-hour window — an approved template is required'
            : 'Failed to send WhatsApp message',
          code: outsideWindow ? 'OUTSIDE_24H_WINDOW' : 'SEND_FAILED',
        },
        502,
      );
    }
  } else {
    // Template mode — deliverable at any time.
    try {
      await sendTemplateMessage(customer_whatsapp, { ...payload, repair_card_url: repairCardUrl }, env);
      historyText = `[Status update sent: ${payload.status_label ?? status} — ${job_id}]`;
      console.log(`[Notify] Sent template '${status}' for ${job_id}`);
    } catch (err) {
      console.error(`[Notify] Template send failed for ${job_id}:`, err?.message ?? err);
      return json(
        { error: err?.message ?? 'Failed to send WhatsApp message', code: 'SEND_FAILED' },
        502,
      );
    }
  }

  // Record it so the bot has context if the customer replies
  // "bila boleh ambil?" straight after receiving this.
  try {
    await saveMessage(env.DB, {
      senderId: customer_whatsapp,
      role: 'assistant',
      text: historyText,
    });
  } catch (err) {
    // Best-effort — never fail a delivered message over logging.
    console.error(`[Notify] Could not save history for ${job_id}:`, err?.message ?? err);
  }

  return json({ sent: true, job_id, status, mode }, 200);
}
