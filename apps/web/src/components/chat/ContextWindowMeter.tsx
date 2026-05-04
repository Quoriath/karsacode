import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

type ContextWindowMeterVariant = "icon" | "pill";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

function getContextWindowTone(usedPercentage: number | null): string {
  if (usedPercentage === null) return "text-muted-foreground";
  if (usedPercentage >= 95) return "text-rose-600 dark:text-rose-400";
  if (usedPercentage >= 85) return "text-orange-600 dark:text-orange-400";
  if (usedPercentage >= 70) return "text-amber-600 dark:text-amber-400";
  return "text-emerald-600 dark:text-emerald-400";
}

function getContextWindowPillTone(usedPercentage: number | null): string {
  if (usedPercentage === null) return "border-border bg-muted/30 text-muted-foreground";
  if (usedPercentage >= 95)
    return "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  if (usedPercentage >= 85)
    return "border-orange-500/35 bg-orange-500/10 text-orange-700 dark:text-orange-300";
  if (usedPercentage >= 70)
    return "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot | null;
  variant?: ContextWindowMeterVariant;
  className?: string;
}) {
  const { usage, variant = "icon", className } = props;
  const usedPercentage = formatPercentage(usage?.usedPercentage ?? null);
  const normalizedPercentage = Math.max(0, Math.min(100, usage?.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference;
  const toneClassName = getContextWindowTone(usage?.usedPercentage ?? null);
  const visibleValue =
    usage === null
      ? "--"
      : usage.usedPercentage !== null
        ? `${Math.round(usage.usedPercentage)}%`
        : formatContextWindowTokens(usage.usedTokens);
  const accessibleLabel =
    usage === null
      ? "Context window usage not available yet"
      : usage.maxTokens !== null && usedPercentage
        ? `Context window ${usedPercentage} used`
        : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`;
  const meter = (
    <span className={cn("relative flex h-6 w-6 items-center justify-center", toneClassName)}>
      <svg
        viewBox="0 0 24 24"
        className="-rotate-90 absolute inset-0 h-full w-full transform-gpu"
        aria-hidden="true"
      >
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke="color-mix(in oklab, var(--color-muted) 70%, transparent)"
          strokeWidth="3"
        />
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
        />
      </svg>
      <span className="relative flex h-[15px] w-[15px] items-center justify-center rounded-full bg-background text-[8px] font-medium">
        {usage === null
          ? "?"
          : usage.usedPercentage !== null
            ? Math.round(usage.usedPercentage)
            : formatContextWindowTokens(usage.usedTokens)}
      </span>
    </span>
  );

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className={cn(
              "group inline-flex shrink-0 items-center justify-center transition-opacity hover:opacity-85",
              variant === "pill"
                ? cn(
                    "h-7 gap-1.5 rounded-full border px-2 text-xs font-medium",
                    getContextWindowPillTone(usage?.usedPercentage ?? null),
                  )
                : "rounded-full",
              className,
            )}
            aria-label={accessibleLabel}
          >
            {meter}
            {variant === "pill" ? (
              <span className="hidden whitespace-nowrap leading-none min-[460px]:inline">
                Context {visibleValue}
              </span>
            ) : null}
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-max max-w-none px-3 py-2">
        <div className="space-y-1.5 leading-tight">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Context window
          </div>
          {usage === null ? (
            <div className="text-xs text-muted-foreground">
              Waiting for the model to report context usage.
            </div>
          ) : usage.maxTokens !== null && usedPercentage ? (
            <div className="whitespace-nowrap text-xs font-medium text-foreground">
              <span>{usedPercentage}</span>
              <span className="mx-1">⋅</span>
              <span>{formatContextWindowTokens(usage.usedTokens)}</span>
              <span>/</span>
              <span>{formatContextWindowTokens(usage.maxTokens ?? null)} context used</span>
            </div>
          ) : (
            <div className="text-sm text-foreground">
              {formatContextWindowTokens(usage.usedTokens)} tokens used so far
            </div>
          )}
          {usage !== null &&
          (usage.totalProcessedTokens ?? null) !== null &&
          (usage.totalProcessedTokens ?? 0) > usage.usedTokens ? (
            <div className="text-xs text-muted-foreground">
              Total processed: {formatContextWindowTokens(usage.totalProcessedTokens ?? null)}{" "}
              tokens
            </div>
          ) : null}
          {usage?.compactsAutomatically ? (
            <div className="text-xs text-muted-foreground">
              Automatically compacts its context when needed.
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
