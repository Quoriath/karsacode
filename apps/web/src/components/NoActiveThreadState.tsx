import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { isElectron } from "../env";
import { cn } from "~/lib/utils";
import { APP_DISPLAY_NAME } from "../branding";

export function NoActiveThreadState() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "border-b border-border px-3 sm:px-5",
            isElectron
              ? "drag-region flex h-[52px] items-center wco:h-[env(titlebar-area-height)]"
              : "py-2 sm:py-3",
          )}
        >
          {isElectron ? (
            <span className="text-xs text-muted-foreground/50 wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]">
              {APP_DISPLAY_NAME}
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
                {APP_DISPLAY_NAME}
              </span>
            </div>
          )}
        </header>

        <Empty className="flex-1">
          <div className="w-full max-w-md rounded-3xl border border-border/50 bg-card/30 px-8 py-14 shadow-sm/5 backdrop-blur-sm">
            <EmptyHeader className="max-w-none">
              <EmptyMedia className="mb-2">
                <div className="relative flex size-16 items-center justify-center">
                  <img
                    alt={APP_DISPLAY_NAME}
                    className="size-12 object-contain animate-[pulse-subtle_2s_ease-in-out_infinite]"
                    src="/apple-touch-icon.png"
                  />
                </div>
              </EmptyMedia>
              <EmptyTitle className="text-foreground text-xl tracking-tight">
                Welcome to {APP_DISPLAY_NAME}
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/80">
                Select an existing thread from the sidebar, or create a new one to start coding with
                AI.
              </EmptyDescription>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
