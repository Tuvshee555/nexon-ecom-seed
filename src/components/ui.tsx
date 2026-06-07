/**
 * DESIGN SYSTEM — one reusable, accessible primitive per concern.
 *
 * Button · Card · Input · Textarea · Select · Badge · Skeleton ·
 * EmptyState · Alert · Modal · Toast · ErrorBoundary · Icons · Logo.
 *
 * All primitives consume the design tokens defined in globals.css, so the
 * UI is mathematically consistent: one radius scale, one shadow scale, one
 * spacing rhythm, one focus system, one brand colour (#113e67).
 */
import Link from "next/link";
import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ErrorInfo,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { t } from "@/lib/strings";

/* ----------------------------------------------------------------
   className helper
   ---------------------------------------------------------------- */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ----------------------------------------------------------------
   Icons — inline, dependency-free, currentColor stroke icons
   ---------------------------------------------------------------- */
type IconProps = { className?: string; size?: number };

function makeIcon(path: ReactNode) {
  return function Icon({ className, size = 18 }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
      >
        {path}
      </svg>
    );
  };
}

export const Icons = {
  menu: makeIcon(
    <>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </>,
  ),
  close: makeIcon(
    <>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </>,
  ),
  search: makeIcon(
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>,
  ),
  refresh: makeIcon(
    <>
      <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
      <path d="M3 21v-5h5" />
    </>,
  ),
  control: makeIcon(
    <>
      <path d="M3 12h4l3 8 4-16 3 8h4" />
    </>,
  ),
  settings: makeIcon(
    <>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="17" x2="20" y2="17" />
      <circle cx="9" cy="7" r="2.4" />
      <circle cx="15" cy="17" r="2.4" />
    </>,
  ),
  ai: makeIcon(
    <>
      <path d="M12 3l1.8 4.8L18.6 9.6 13.8 11.4 12 16.2 10.2 11.4 5.4 9.6 10.2 7.8z" />
      <path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
    </>,
  ),
  trips: makeIcon(
    <>
      <path d="M9 3 3.5 5.2v15.3L9 18l6 3 5.5-2.2V3.5L15 6 9 3z" />
      <line x1="9" y1="3" x2="9" y2="18" />
      <line x1="15" y1="6" x2="15" y2="21" />
    </>,
  ),
  pause: makeIcon(
    <>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </>,
  ),
  play: makeIcon(<path d="M7 4.5v15l13-7.5z" />),
  plus: makeIcon(
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>,
  ),
  trash: makeIcon(
    <>
      <path d="M4 7h16" />
      <path d="M9 7V4.5h6V7" />
      <path d="M6 7l1 13h10l1-13" />
    </>,
  ),
  edit: makeIcon(
    <>
      <path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.8-2.8L5 17.2V20z" />
      <line x1="13.5" y1="9" x2="16" y2="11.5" />
    </>,
  ),
  download: makeIcon(
    <>
      <path d="M12 3v12" />
      <path d="M7 11l5 5 5-5" />
      <path d="M4 21h16" />
    </>,
  ),
  check: makeIcon(<path d="M5 12.5 10 17.5 19.5 7" />),
  alert: makeIcon(
    <>
      <path d="M12 3 1.5 21h21L12 3z" />
      <line x1="12" y1="9.5" x2="12" y2="14" />
      <line x1="12" y1="17.4" x2="12" y2="17.5" />
    </>,
  ),
  info: makeIcon(
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16.5" />
      <line x1="12" y1="7.6" x2="12" y2="7.7" />
    </>,
  ),
  database: makeIcon(
    <>
      <ellipse cx="12" cy="5.5" rx="7.5" ry="3" />
      <path d="M4.5 5.5v13c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-13" />
      <path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
    </>,
  ),
};

/* ----------------------------------------------------------------
   Logo
   ---------------------------------------------------------------- */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cx("flex items-center gap-2.5", className)}>
      <span
        aria-hidden="true"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand text-base font-bold text-white"
      >
        У
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-sm font-semibold text-ink">
          {t.app.name}
        </span>
        <span className="truncate text-[11px] font-medium text-ink-subtle">
          {t.app.tagline}
        </span>
      </span>
    </span>
  );
}

/* ----------------------------------------------------------------
   Spinner
   ---------------------------------------------------------------- */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cx("animate-spin", className)}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="3"
        opacity="0.25"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ----------------------------------------------------------------
   Button — one system, five intents, three sizes
   ---------------------------------------------------------------- */
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success";
type ButtonSize = "sm" | "md" | "lg";

const BTN_BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border font-semibold transition-colors select-none disabled:cursor-not-allowed disabled:opacity-50";

const BTN_VARIANT: Record<ButtonVariant, string> = {
  primary:
    "border-transparent bg-brand text-white hover:bg-brand-hover active:bg-brand-active",
  secondary:
    "border-line-strong bg-surface text-ink hover:bg-surface-sunken",
  ghost:
    "border-transparent bg-transparent text-ink-muted hover:bg-surface-sunken hover:text-ink",
  danger:
    "border-transparent bg-danger text-white hover:bg-danger-hover",
  success:
    "border-transparent bg-success text-white hover:bg-success-hover",
};

const BTN_SIZE: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-[13px]",
  md: "h-10 px-4 text-sm",
  lg: "h-11 px-5 text-sm",
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  block?: boolean;
  href?: string;
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  block = false,
  href,
  className,
  children,
  disabled,
  type,
  ...rest
}: ButtonProps) {
  const classes = cx(
    BTN_BASE,
    BTN_VARIANT[variant],
    BTN_SIZE[size],
    block && "w-full",
    className,
  );

  if (href) {
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }

  return (
    <button
      type={type ?? "button"}
      className={classes}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

/* ----------------------------------------------------------------
   Card + PanelHeader
   ---------------------------------------------------------------- */
export function Card({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx(
        "rounded-xl border border-line bg-surface shadow-sm",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function PanelHeader({
  title,
  description,
  actions,
  titleId,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  titleId?: string;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 id={titleId} className="text-base font-semibold text-ink">
          {title}
        </h2>
        {description && (
          <p className="mt-1 text-sm text-ink-muted">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------
   Badge
   ---------------------------------------------------------------- */
type BadgeTone = "brand" | "success" | "danger" | "warning" | "neutral";

const BADGE_TONE: Record<BadgeTone, string> = {
  brand: "bg-brand-soft text-brand",
  success: "bg-success-soft text-success",
  danger: "bg-danger-soft text-danger",
  warning: "bg-warning-soft text-warning",
  neutral: "bg-surface-sunken text-ink-muted",
};

const DOT_TONE: Record<BadgeTone, string> = {
  brand: "bg-brand",
  success: "bg-success",
  danger: "bg-danger",
  warning: "bg-warning",
  neutral: "bg-ink-subtle",
};

export function Badge({
  tone = "neutral",
  dot = false,
  children,
  className,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
        BADGE_TONE[tone],
        className,
      )}
    >
      {dot && (
        <span
          aria-hidden="true"
          className={cx("h-1.5 w-1.5 rounded-full", DOT_TONE[tone])}
        />
      )}
      {children}
    </span>
  );
}

/* ----------------------------------------------------------------
   Form controls — label is always bound to the control
   ---------------------------------------------------------------- */
const CONTROL_BASE =
  "w-full rounded-md border bg-surface text-sm text-ink transition-colors placeholder:text-ink-subtle focus:border-brand disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:opacity-70";

function FieldShell({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label?: string;
  hint?: string;
  error?: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-xs font-medium text-danger">{error}</p>
      ) : hint ? (
        <p className="text-xs text-ink-subtle">{hint}</p>
      ) : null}
    </div>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  error?: string;
};

export function Input({
  label,
  hint,
  error,
  id,
  className,
  ...rest
}: InputProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldShell label={label} hint={hint} error={error} htmlFor={fieldId}>
      <input
        id={fieldId}
        className={cx(
          CONTROL_BASE,
          "h-10 px-3",
          error ? "border-danger" : "border-line-strong",
          className,
        )}
        {...rest}
      />
    </FieldShell>
  );
}

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string;
  hint?: string;
  error?: string;
};

export function Textarea({
  label,
  hint,
  error,
  id,
  className,
  rows = 4,
  ...rest
}: TextareaProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldShell label={label} hint={hint} error={error} htmlFor={fieldId}>
      <textarea
        id={fieldId}
        rows={rows}
        className={cx(
          CONTROL_BASE,
          "resize-y px-3 py-2 leading-relaxed",
          error ? "border-danger" : "border-line-strong",
          className,
        )}
        {...rest}
      />
    </FieldShell>
  );
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
  hint?: string;
  error?: string;
};

export function Select({
  label,
  hint,
  error,
  id,
  className,
  children,
  ...rest
}: SelectProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldShell label={label} hint={hint} error={error} htmlFor={fieldId}>
      <select
        id={fieldId}
        className={cx(
          CONTROL_BASE,
          "h-10 px-3",
          error ? "border-danger" : "border-line-strong",
          className,
        )}
        {...rest}
      >
        {children}
      </select>
    </FieldShell>
  );
}

/* ----------------------------------------------------------------
   Skeleton
   ---------------------------------------------------------------- */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton", className)} aria-hidden="true" />;
}

/* ----------------------------------------------------------------
   EmptyState
   ---------------------------------------------------------------- */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong px-6 py-10 text-center">
      {icon && <div className="text-ink-subtle">{icon}</div>}
      <p className="text-sm font-semibold text-ink">{title}</p>
      {description && (
        <p className="max-w-sm text-sm text-ink-muted">{description}</p>
      )}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/* ----------------------------------------------------------------
   Alert — inline, contextual messaging
   ---------------------------------------------------------------- */
type AlertTone = "danger" | "success" | "warning" | "info";

const ALERT_TONE: Record<AlertTone, string> = {
  danger: "border-danger/25 bg-danger-soft text-danger",
  success: "border-success/25 bg-success-soft text-success",
  warning: "border-warning/25 bg-warning-soft text-warning",
  info: "border-brand/20 bg-brand-soft text-brand",
};

export function Alert({
  tone = "info",
  children,
}: {
  tone?: AlertTone;
  children: ReactNode;
}) {
  return (
    <div
      role="alert"
      className={cx(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
        ALERT_TONE[tone],
      )}
    >
      <span className="mt-0.5 shrink-0">
        {tone === "success" ? (
          <Icons.check size={16} />
        ) : tone === "info" ? (
          <Icons.info size={16} />
        ) : (
          <Icons.alert size={16} />
        )}
      </span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/* ----------------------------------------------------------------
   Modal — accessible dialog: focus trap, Esc, scroll-lock,
   focus restoration, scrollable body, reachable footer.
   ---------------------------------------------------------------- */
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    const focusTimer = window.setTimeout(() => {
      const target = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      target?.focus();
    }, 30);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      window.clearTimeout(focusTimer);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div
        className="absolute inset-0 bg-ink/55"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className="relative flex max-h-[92dvh] w-full max-w-2xl flex-col rounded-t-xl bg-surface shadow-lg sm:max-h-[88dvh] sm:rounded-xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-ink">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-0.5 truncate text-sm text-ink-muted">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.common.close}
            className="-mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
          >
            <Icons.close />
          </button>
        </div>

        <div className="scroll-area min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {children}
        </div>

        {footer && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Toast — non-blocking, accessible feedback
   ---------------------------------------------------------------- */
type ToastTone = "success" | "error" | "info";
type ToastItem = { id: number; tone: ToastTone; message: string };

type ToastApi = {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const TOAST_TONE: Record<ToastTone, string> = {
  success: "border-success/25 bg-success-soft text-success",
  error: "border-danger/25 bg-danger-soft text-danger",
  info: "border-brand/20 bg-brand-soft text-brand",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string) => {
      const id = (idRef.current += 1);
      setItems((prev) => [...prev, { id, tone, message }]);
      window.setTimeout(() => remove(id), 5000);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push("success", message),
      error: (message) => push("error", message),
      info: (message) => push("info", message),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-60 flex flex-col items-center gap-2 p-4 sm:items-end"
        aria-live="polite"
        role="status"
      >
        {items.map((item) => (
          <div
            key={item.id}
            className={cx(
              "pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border px-3.5 py-3 shadow-md",
              TOAST_TONE[item.tone],
            )}
          >
            <span className="mt-0.5 shrink-0">
              {item.tone === "success" ? (
                <Icons.check size={16} />
              ) : item.tone === "error" ? (
                <Icons.alert size={16} />
              ) : (
                <Icons.info size={16} />
              )}
            </span>
            <p className="min-w-0 flex-1 text-sm font-medium">{item.message}</p>
            <button
              type="button"
              onClick={() => remove(item.id)}
              aria-label={t.common.close}
              className="-mr-1 -mt-1 shrink-0 rounded p-1 opacity-70 transition-opacity hover:opacity-100"
            >
              <Icons.close size={15} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within <ToastProvider>");
  }
  return ctx;
}

/* ----------------------------------------------------------------
   ErrorBoundary — prevents a single render throw from
   white-screening the whole app.
   ---------------------------------------------------------------- */
type ErrorBoundaryState = { hasError: boolean };

export class ErrorBoundary extends Component<
  { children: ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (typeof console !== "undefined") {
      console.error("Unhandled UI error:", error, info.componentStack);
    }
  }

  private handleReload = () => {
    if (typeof window !== "undefined") window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="flex min-h-dvh items-center justify-center px-4">
        <Card className="w-full max-w-md p-6 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-danger-soft text-danger">
            <Icons.alert size={22} />
          </div>
          <h1 className="mt-4 text-lg font-semibold text-ink">
            {t.errors.boundaryTitle}
          </h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            {t.errors.boundaryBody}
          </p>
          <div className="mt-5">
            <Button onClick={this.handleReload} block>
              {t.errors.boundaryAction}
            </Button>
          </div>
        </Card>
      </div>
    );
  }
}
