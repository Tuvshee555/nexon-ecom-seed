import { getEnv } from "./env";
import { sendTextMessage, type UpstreamTraceOptions } from "./messenger";
import { logInfo, logWarn, recordCounter } from "./observability";

const env = getEnv();

export type StaffLeadAlert = {
  kind: "handoff" | "booking";
  platform: string;
  customerMessage: string;
  contactPhone?: string;
};

function buildAlertText(alert: StaffLeadAlert): string {
  const heading =
    alert.kind === "handoff"
      ? "🔔 Шинэ хүсэлт — хэрэглэгч хүнтэй ярихыг хүсэв"
      : "🔔 Шинэ хүсэлт — захиалгын сонирхол";
  const channel = alert.platform === "instagram" ? "Instagram" : "Facebook";
  const lines = [
    heading,
    `Суваг: ${channel}`,
    `Зурвас: "${alert.customerMessage.slice(0, 300)}"`,
  ];
  if (alert.contactPhone) lines.push(`Утас: ${alert.contactPhone}`);
  lines.push("Дэлгэрэнгүйг админ самбарын «Хүсэлтүүд» хэсгээс хараарай.");
  return lines.join("\n");
}

/**
 * Best-effort Messenger ping to configured staff accounts. Never throws — a
 * failed staff alert must not break customer-facing webhook delivery. Staff
 * PSIDs are page-scoped, so the Facebook page token is used regardless of the
 * channel the customer arrived on.
 */
export async function notifyStaffOfLead(
  alert: StaffLeadAlert,
  trace?: UpstreamTraceOptions,
): Promise<void> {
  const recipients = env.staffNotifyPsids;
  if (recipients.length === 0) return;
  const text = buildAlertText(alert);
  for (const psid of recipients) {
    try {
      await sendTextMessage(psid, text, env.tokenPage, trace);
      recordCounter("staff_alert.sent_total", 1, { kind: alert.kind });
      logInfo("staff_alert.sent", { kind: alert.kind });
    } catch (error) {
      recordCounter("staff_alert.failed_total", 1, { kind: alert.kind });
      logWarn("staff_alert.failed", {
        kind: alert.kind,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
