import { Undo2Icon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Re-render every `intervalMs`; return a stable timestamp snapshot for render-time relative labels. */
export function useRelativeTimeTick(intervalMs = 1_000) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return nowMs;
}

export function SettingsSection({
  title,
  icon,
  headerAction,
  children,
}: {
  title: string;
  icon?: ReactNode;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex h-5 items-center justify-between px-1">
        <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/60">
          <span className="inline-block h-px w-3 bg-border" aria-hidden />
          {icon}
          {title}
        </h2>
        <div className="flex h-5 min-w-5 items-center justify-end">{headerAction}</div>
      </div>
      <div className="relative overflow-hidden rounded-xl border border-border/70 bg-card text-card-foreground shadow-sm/8 transition-colors duration-200">
        {children}
      </div>
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  status,
  resetAction,
  control,
  children,
}: {
  title: ReactNode;
  description: string;
  status?: ReactNode;
  resetAction?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "border-t border-border/60 px-3.5 first:border-t-0 sm:px-4",
        children ? "py-3" : "py-3",
      )}
    >
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
              {title}
            </h3>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
              {resetAction}
            </span>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground/80">{description}</p>
          {status ? <div className="pt-0.5 text-[11px] text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function SettingResetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Reset ${label} to default`}
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">Reset to default</TooltipPopup>
    </Tooltip>
  );
}

export function SettingsPageContainer({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 overflow-y-auto bg-background p-5 sm:p-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">{children}</div>
    </div>
  );
}
