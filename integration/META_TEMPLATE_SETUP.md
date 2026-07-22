# WhatsApp message template — `repair_status_update`

Create this in **Meta Business Suite → WhatsApp Manager → Message Templates → Create**.

`integration/alia-notify.js` sends exactly this shape. If you change the body
text, keep the **number and order of `{{n}}` variables identical** or the send
fails with error `132000` (parameter count mismatch).

---

## Why one template, not seven

A single template with the status as a variable covers all seven stages.
Seven separate templates would mean seven approvals, seven rejection risks, and
seven things to edit when the copy changes.

---

## Template settings

| Field | Value |
| --- | --- |
| **Name** | `repair_status_update` |
| **Category** | **Utility** ⚠️ not Marketing — see note below |
| **Language** | Malay (`ms`) |

> **Category matters.** *Utility* templates are for transactional updates about
> an existing order or service — which this is. They're approved faster and
> cost less than *Marketing*. Picking Marketing for this content is a common
> cause of rejection.

---

## Body

```
Hi {{1}}! 👋

Status pembaikan peranti anda telah dikemas kini.

📱 Peranti: {{2}}
📋 No. Job: {{3}}
🔧 Status terkini: {{4}}
📍 Cawangan: {{5}}

Tekan butang di bawah untuk lihat butiran penuh, gambar peranti dan status waranti anda.

Terima kasih kerana memilih iFix Express!
```

### Sample values (Meta requires these to approve)

| Variable | Sample |
| --- | --- |
| `{{1}}` | `Aisyah` |
| `{{2}}` | `iPhone 13` |
| `{{3}}` | `IFX-00001` |
| `{{4}}` | `Sedia Untuk Diambil` |
| `{{5}}` | `iFix Express Alor Setar` |

---

## Button

Add **one** button — type **Visit website**, **Dynamic**:

| Field | Value |
| --- | --- |
| Button text | `Lihat Status Repair` |
| URL type | Dynamic |
| URL | `https://app.ifixexpress.com.my/track/{{1}}` |
| Sample | `IFX-00001` |

The handler passes the job ID as the button variable, producing
`https://app.ifixexpress.com.my/track/IFX-00001`.

> Button variables are numbered **separately** from body variables — the
> button's `{{1}}` is not the body's `{{1}}`.

---

## Footer (optional)

```
iFix Express — Kedah & Pulau Pinang
```

---

## After approval

1. Confirm the name and language match your config. Defaults are
   `repair_status_update` / `ms`; override on **repair-bot-worker**:
   ```jsonc
   "vars": {
     "WA_NOTIFY_MODE": "template",
     "WA_STATUS_TEMPLATE_NAME": "repair_status_update",
     "WA_TEMPLATE_LANG": "ms"
   }
   ```
2. Deploy repair-bot-worker.
3. Trigger a real status change in RepairTrack and confirm `notified: true`.

---

## While waiting for approval

Set `WA_NOTIFY_MODE = "freeform"`. Alia sends richer natural-language messages
with no approval needed — but **only within 24 hours of the customer's last
message**. Outside that, the send fails and RepairTrack surfaces
`Outside the 24-hour window`.

For customers outside the window, use the **manual WhatsApp share** fallback
(currently commented out in `src/routes/jobs.ts` — search for
`MANUAL WHATSAPP SHARE FALLBACK`).

---

## Status labels sent as `{{4}}`

| Status | Label |
| --- | --- |
| `received` | Device Received |
| `diagnosing` | Diagnosing Issue |
| `awaiting_parts` | Awaiting Parts |
| `in_progress` | Repair In Progress |
| `quality_check` | Quality Check |
| `ready_for_collection` | Ready for Collection |
| `collected` | Collected |

These come from `STATUS_LABELS` in `src/types.ts`. To show Malay labels to
customers, change them there — RepairTrack sends the label, Alia just relays it.

---

## Common rejection reasons

| Cause | Fix |
| --- | --- |
| Category set to Marketing | Resubmit as Utility |
| Missing sample values | Fill every variable sample |
| Variable at the very start/end of body | Keep surrounding text (this template does) |
| Two variables adjacent (`{{1}} {{2}}`) | Keep static text between them |
