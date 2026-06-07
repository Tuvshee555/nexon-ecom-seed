import { useEffect, useRef, useState } from "react";
import { Badge, Button, Icons, cx } from "@/components/ui";

type ChatMessage = {
  from: "user" | "bot";
  text: string;
};

type DemoChatProps = {
  className?: string;
  title?: string;
  description?: string;
  showHeader?: boolean;
  placeholder?: string;
  suggestions?: string[];
};

const DEFAULT_SUGGESTIONS = [
  "Хөх хотын аяллын үнэ хэд вэ?",
  "Ирэх сард ямар аяллууд гарах вэ?",
  "2 том хүн, 2 хүүхдийн аялалд хөнгөлөлт бий юу?",
];

const DEMO_CONVERSATION_KEY = "demo_conversation_id";

function getConversationId(): string {
  if (typeof window === "undefined") return "";
  const existing = window.sessionStorage.getItem(DEMO_CONVERSATION_KEY);
  if (existing) return existing;

  const nextId =
    typeof window.crypto?.randomUUID === "function"
      ? window.crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 18)}`;

  window.sessionStorage.setItem(DEMO_CONVERSATION_KEY, nextId);
  return nextId;
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1 px-1 py-1">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="h-2 w-2 animate-bounce rounded-full bg-ink-subtle"
          style={{ animationDelay: `${index * 0.12}s` }}
        />
      ))}
    </div>
  );
}

export default function DemoChat({
  className,
  title = "Шууд хариулт шалгах",
  description = "Хэрэглэгчийн асуултаар туршаад ботын бодит хариуг шууд шалгана.",
  showHeader = true,
  placeholder = "Маршрут, үнэ, гарах өдөр, хоол, суудлын талаар асуугаарай...",
  suggestions = DEFAULT_SUGGESTIONS,
}: DemoChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [conversationId, setConversationId] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setConversationId(getConversationId());
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  async function send(textOverride?: string) {
    const payload = (textOverride ?? input).trim();
    if (!payload || sending || !conversationId) return;

    setMessages((prev) => [...prev, { from: "user", text: payload }]);
    setInput("");
    setSending(true);
    try {
      const response = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: payload, conversationId }),
      });
      const json = await response.json();
      setMessages((prev) => [
        ...prev,
        {
          from: "bot",
          text:
            typeof json?.reply === "string" && json.reply.trim()
              ? json.reply
              : "Хариу боловсруулах үед алдаа гарлаа.",
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          from: "bot",
          text: "Уучлаарай, сервертэй холбогдоход алдаа гарлаа.",
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={cx("space-y-4", className)}>
      {showHeader && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-ink">{title}</h3>
            <p className="mt-1 text-sm text-ink-muted">{description}</p>
          </div>
          <Badge tone="brand">Бодит хариулт</Badge>
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="scroll-area flex gap-2 overflow-x-auto pb-1">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              disabled={sending || !conversationId}
              onClick={() => void send(suggestion)}
              className="shrink-0 rounded-full border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:border-brand hover:text-brand"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      <div className="overflow-hidden rounded-[20px] border border-line bg-surface shadow-sm">
        <div className="border-b border-line bg-linear-to-r from-brand-soft via-surface to-surface px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-brand text-white">
              <Icons.ai size={18} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">Хэрэглэгчид очих хариулт</p>
              <p className="mt-0.5 text-xs text-ink-muted">
                Энэ нь нийтийн туршилтын чатын яг ижил API-г ашиглаж байна.
              </p>
            </div>
          </div>
        </div>

        <div
          aria-live="polite"
          className="scroll-area h-[28rem] overflow-y-auto bg-canvas/55 px-4 py-4"
        >
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 rounded-[18px] border border-dashed border-line-strong bg-surface px-6 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-soft text-brand">
                <Icons.ai size={20} />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold text-ink">Одоогоор мессеж алга</p>
                <p className="max-w-md text-sm text-ink-muted">
                  Үнэ, суудал, гарах өдөр, хоол эсвэл маршруттай холбоотой
                  бодит асуултаар туршаарай.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {messages.map((message, index) => (
                <div
                  key={`${message.from}-${index}`}
                  className={cx(
                    "flex",
                    message.from === "user" ? "justify-end" : "justify-start",
                  )}
                >
                  <div
                    className={cx(
                      "max-w-[88%] rounded-[20px] px-4 py-3 text-sm leading-relaxed shadow-sm",
                      message.from === "user"
                        ? "rounded-br-md bg-brand text-white"
                        : "rounded-bl-md border border-line bg-surface text-ink",
                    )}
                  >
                    {message.text}
                  </div>
                </div>
              ))}
              {sending && (
                <div className="flex justify-start">
                  <div className="rounded-[20px] rounded-bl-md border border-line bg-surface px-3 py-2 shadow-sm">
                    <TypingDots />
                  </div>
                </div>
              )}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="border-t border-line bg-surface px-4 py-4">
          <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <div className="space-y-2">
              <label className="text-sm font-medium text-ink" htmlFor="demo-chat-input">
                Туршилтын асуулт
              </label>
              <textarea
                id="demo-chat-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                className="min-h-24 w-full resize-y rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm leading-relaxed text-ink transition-colors placeholder:text-ink-subtle focus:border-brand disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:opacity-70"
                placeholder={placeholder}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                disabled={sending || !conversationId}
              />
              <p className="text-xs text-ink-subtle">
                `Enter` дарж илгээнэ. Шинэ мөр авах бол `Shift+Enter` ашиглана.
              </p>
            </div>
            <Button
              size="lg"
              loading={sending}
              disabled={sending || !input.trim() || !conversationId}
              onClick={() => void send()}
              className="md:min-w-36"
            >
              <Icons.play size={16} />
              Илгээх
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
