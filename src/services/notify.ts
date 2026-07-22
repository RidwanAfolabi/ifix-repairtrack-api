/**
 * Step 8 — trigger Alia (the repair-bot-worker) to send a WhatsApp message.
 *
 * This API NEVER sends WhatsApp messages itself. It hands a payload to the
 * already-deployed repair-bot-worker, which owns the Meta WhatsApp Cloud API
 * credentials and the Gemini prompt that decides the wording.
 *
 * Called from exactly ONE place: PATCH /api/jobs/:jobId/status.
 * Never on job creation — intake sharing is a staff-initiated frontend
 * wa.me link, and Alia is not involved.
 *
 * Transport is an HTTP fetch to ALIA_WORKER_URL. To move to a service
 * binding later, replace the fetch in `send()` with `env.ALIA.fetch(...)`;
 * the payload and the caller stay identical.
 */
import type { JobStatus } from "../types";

export interface StatusUpdateNotification {
  type: "status_update";
  status: JobStatus;
  /** Customer-friendly label; Alia's prompt decides final phrasing. */
  status_label: string;
  customer_whatsapp: string;
  customer_name: string;
  device_model: string;
  job_id: string;
  branch_name: string;
  repair_card_url: string;
  staff_note?: string;
}

export type NotifyOutcome =
  | { ok: true }
  | { ok: false; warning: string };

/** Don't let a hung bot worker hold the staff's status update open. */
const TIMEOUT_MS = 5000;

/**
 * Fire the notification. NEVER throws — a notify failure must not fail the
 * status update that triggered it. Returns an outcome the route surfaces as
 * a `warning` so the frontend can tell staff the message didn't go out.
 */
export async function notifyAlia(
  aliaWorkerUrl: string | undefined,
  payload: StatusUpdateNotification,
  notifySecret?: string,
): Promise<NotifyOutcome> {
  if (!aliaWorkerUrl) {
    const warning = "ALIA_WORKER_URL is not configured — no WhatsApp message was sent";
    console.error(warning);
    return { ok: false, warning };
  }

  try {
    const response = await fetch(`${aliaWorkerUrl.replace(/\/$/, "")}/notify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Shared secret. Without it, anyone who finds the bot's public URL
        // could POST arbitrary payloads and send WhatsApp messages from the
        // business number.
        ...(notifySecret ? { "X-RepairTrack-Secret": notifySecret } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");

      // 404 almost always means the bot worker has not had the /notify
      // endpoint added yet — call that out rather than a generic failure.
      const warning =
        response.status === 404
          ? "Alia has no /notify endpoint — the customer was not notified"
          : `Alia responded ${response.status} — the customer may not have been notified`;

      console.error(warning, detail.slice(0, 500));
      return { ok: false, warning };
    }

    return { ok: true };
  } catch (err) {
    const warning =
      err instanceof Error && err.name === "TimeoutError"
        ? "Alia did not respond in time — the customer may not have been notified"
        : "Could not reach Alia — the customer was not notified";
    console.error(warning, err);
    return { ok: false, warning };
  }
}
