import { CheckIcon, MonitorIcon, MoonIcon, PaletteIcon, SunIcon, XIcon } from "lucide-react";
import { type ReactNode, useState, useEffect } from "react";

import type { Theme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

export interface ThemeOption {
  readonly value: Theme;
  readonly label: string;
  readonly icon: ReactNode;
  readonly description?: string;
  readonly colors: {
    readonly background: string;
    readonly foreground: string;
    readonly primary: string;
    readonly secondary: string;
    readonly accent: string;
  };
}

const BASIC_THEME_OPTIONS: ThemeOption[] = [
  {
    value: "system",
    label: "System",
    icon: <MonitorIcon className="size-5" />,
    description: "Follow your system preference",
    colors: {
      background: "#ffffff",
      foreground: "#09090b",
      primary: "#18181b",
      secondary: "#f4f4f5",
      accent: "#3b82f6",
    },
  },
  {
    value: "light",
    label: "Light",
    icon: <SunIcon className="size-5" />,
    description: "Clean and bright",
    colors: {
      background: "#ffffff",
      foreground: "#09090b",
      primary: "#18181b",
      secondary: "#f4f4f5",
      accent: "#3b82f6",
    },
  },
  {
    value: "dark",
    label: "Dark",
    icon: <MoonIcon className="size-5" />,
    description: "Easy on the eyes",
    colors: {
      background: "#09090b",
      foreground: "#fafafa",
      primary: "#fafafa",
      secondary: "#27272a",
      accent: "#3b82f6",
    },
  },
] as const;

const CUSTOM_THEME_OPTIONS: ThemeOption[] = [
  {
    value: "github-dark",
    label: "GitHub Dark",
    icon: <MoonIcon className="size-4" />,
    description: "GitHub's dark theme",
    colors: {
      background: "#0d1117",
      foreground: "#c9d1d9",
      primary: "#c9d1d9",
      secondary: "#161b22",
      accent: "#58a6ff",
    },
  },
  {
    value: "github-light",
    label: "GitHub Light",
    icon: <SunIcon className="size-4" />,
    description: "GitHub's light theme",
    colors: {
      background: "#ffffff",
      foreground: "#24292f",
      primary: "#24292f",
      secondary: "#f6f8fa",
      accent: "#0969da",
    },
  },
  {
    value: "nord",
    label: "Nord",
    icon: <MoonIcon className="size-4" />,
    description: "Arctic, north-bluish color palette",
    colors: {
      background: "#2e3440",
      foreground: "#eceff4",
      primary: "#eceff4",
      secondary: "#3b4252",
      accent: "#88c0d0",
    },
  },
  {
    value: "dracula",
    label: "Dracula",
    icon: <MoonIcon className="size-4" />,
    description: "Dark theme for syntax highlighting",
    colors: {
      background: "#282a36",
      foreground: "#f8f8f2",
      primary: "#f8f8f2",
      secondary: "#44475a",
      accent: "#bd93f9",
    },
  },
  {
    value: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    icon: <MoonIcon className="size-4" />,
    description: "Soft pastel dark theme",
    colors: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      primary: "#cdd6f4",
      secondary: "#313244",
      accent: "#cba6f7",
    },
  },
  {
    value: "catppuccin-latte",
    label: "Catppuccin Latte",
    icon: <SunIcon className="size-4" />,
    description: "Soft pastel light theme",
    colors: {
      background: "#eff1f5",
      foreground: "#4c4f69",
      primary: "#4c4f69",
      secondary: "#e6e9ef",
      accent: "#8839ef",
    },
  },
  {
    value: "vscode-dark",
    label: "VS Code Dark+",
    icon: <MoonIcon className="size-4" />,
    description: "Visual Studio Code's default dark",
    colors: {
      background: "#1e1e1e",
      foreground: "#d4d4d4",
      primary: "#d4d4d4",
      secondary: "#252526",
      accent: "#007acc",
    },
  },
  {
    value: "vscode-light",
    label: "VS Code Light+",
    icon: <SunIcon className="size-4" />,
    description: "Visual Studio Code's default light",
    colors: {
      background: "#ffffff",
      foreground: "#333333",
      primary: "#333333",
      secondary: "#f3f3f3",
      accent: "#0066b8",
    },
  },
  {
    value: "gruvbox-dark",
    label: "Gruvbox Dark",
    icon: <MoonIcon className="size-4" />,
    description: "Retro groove color scheme",
    colors: {
      background: "#282828",
      foreground: "#ebdbb2",
      primary: "#ebdbb2",
      secondary: "#3c3836",
      accent: "#fe8019",
    },
  },
  {
    value: "gruvbox-light",
    label: "Gruvbox Light",
    icon: <SunIcon className="size-4" />,
    description: "Retro groove light color scheme",
    colors: {
      background: "#fbf1c7",
      foreground: "#3c3836",
      primary: "#3c3836",
      secondary: "#ebdbb2",
      accent: "#af3a03",
    },
  },
  {
    value: "monokai",
    label: "Monokai",
    icon: <MoonIcon className="size-4" />,
    description: "Classic dark theme",
    colors: {
      background: "#272822",
      foreground: "#f8f8f2",
      primary: "#f8f8f2",
      secondary: "#3e3d32",
      accent: "#a6e22e",
    },
  },
  {
    value: "solarized-dark",
    label: "Solarized Dark",
    icon: <MoonIcon className="size-4" />,
    description: "Precision colors for screens",
    colors: {
      background: "#002b36",
      foreground: "#839496",
      primary: "#839496",
      secondary: "#073642",
      accent: "#2aa198",
    },
  },
  {
    value: "solarized-light",
    label: "Solarized Light",
    icon: <SunIcon className="size-4" />,
    description: "Precision colors for screens",
    colors: {
      background: "#fdf6e3",
      foreground: "#657b83",
      primary: "#657b83",
      secondary: "#eee8d5",
      accent: "#2aa198",
    },
  },
  {
    value: "tokyo-night",
    label: "Tokyo Night",
    icon: <MoonIcon className="size-4" />,
    description: "A clean, dark and beautiful theme",
    colors: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      primary: "#c0caf5",
      secondary: "#24283b",
      accent: "#7aa2f7",
    },
  },
  {
    value: "rose-pine",
    label: "Rose Pine",
    icon: <MoonIcon className="size-4" />,
    description: "All natural pine, faux fur and a couple of roses",
    colors: {
      background: "#191724",
      foreground: "#e0def4",
      primary: "#e0def4",
      secondary: "#26233a",
      accent: "#9ccfd8",
    },
  },
  {
    value: "one-dark",
    label: "One Dark",
    icon: <MoonIcon className="size-4" />,
    description: "Atom's default dark theme",
    colors: {
      background: "#282c34",
      foreground: "#abb2bf",
      primary: "#abb2bf",
      secondary: "#21252b",
      accent: "#61afef",
    },
  },
] as const;

function ThemePreview({ colors }: { colors: ThemeOption["colors"] }) {
  return (
    <div className="relative h-20 w-full overflow-hidden rounded-lg">
      {/* Background */}
      <div className="absolute inset-0" style={{ backgroundColor: colors.background }} />

      {/* Decorative elements */}
      <div className="absolute inset-0 p-2.5">
        {/* Top bar */}
        <div
          className="mb-2 h-2 w-full rounded-full opacity-60"
          style={{ backgroundColor: colors.primary }}
        />

        {/* Content blocks */}
        <div className="flex gap-2">
          <div className="flex-1 space-y-1.5">
            <div
              className="h-2 w-3/4 rounded-full opacity-50"
              style={{ backgroundColor: colors.foreground }}
            />
            <div
              className="h-2 w-1/2 rounded-full opacity-30"
              style={{ backgroundColor: colors.foreground }}
            />
          </div>
          <div
            className="h-6 w-6 shrink-0 rounded-md opacity-40"
            style={{ backgroundColor: colors.accent }}
          />
        </div>

        {/* Bottom accent bar */}
        <div className="mt-2 flex gap-1">
          <div className="h-1.5 w-1/3 rounded-full" style={{ backgroundColor: colors.accent }} />
          <div
            className="h-1.5 w-1/4 rounded-full opacity-50"
            style={{ backgroundColor: colors.secondary }}
          />
        </div>
      </div>

      {/* Gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/10 to-transparent" />
    </div>
  );
}

function ThemeCard({
  option,
  isSelected,
  onSelect,
}: {
  option: ThemeOption;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group relative w-full overflow-hidden rounded-xl border-2 text-left transition-all duration-300 ease-out",
        "hover:shadow-xl hover:-translate-y-1",
        "active:scale-[0.97] active:duration-100",
        isSelected
          ? "border-[var(--accent-color)] shadow-lg shadow-[var(--accent-color)]/10"
          : "border-transparent hover:border-[var(--accent-color)]/30",
      )}
      style={
        {
          "--accent-color": option.colors.accent,
          backgroundColor: option.colors.background,
        } as React.CSSProperties
      }
    >
      {/* Glow effect on hover */}
      <div
        className="absolute -inset-px rounded-xl opacity-0 transition-opacity duration-500 group-hover:opacity-100"
        style={{
          background: `radial-gradient(circle at center, ${option.colors.accent}15, transparent 70%)`,
        }}
      />

      {/* Inner border */}
      <div className="absolute inset-0 rounded-xl border border-white/5" />

      <div className="relative flex flex-col gap-0">
        {/* Preview */}
        <div className="p-2.5">
          <ThemePreview colors={option.colors} />
        </div>

        {/* Info */}
        <div className="flex items-start justify-between gap-2 p-3 pt-0">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div
              className="flex size-7 shrink-0 items-center justify-center rounded-md"
              style={{
                backgroundColor: `${option.colors.accent}20`,
                color: option.colors.accent,
              }}
            >
              {option.icon}
            </div>
            <div className="flex min-w-0 flex-col">
              <span
                className="truncate text-sm font-semibold leading-tight"
                style={{ color: option.colors.foreground }}
              >
                {option.label}
              </span>
              {option.description ? (
                <span
                  className="truncate text-[11px] leading-tight opacity-60"
                  style={{ color: option.colors.foreground }}
                >
                  {option.description}
                </span>
              ) : null}
            </div>
          </div>

          {/* Checkmark */}
          {isSelected ? (
            <div
              className="flex size-7 shrink-0 items-center justify-center rounded-full shadow-md"
              style={{
                backgroundColor: option.colors.accent,
              }}
            >
              <CheckIcon className="size-4 text-white" />
            </div>
          ) : null}
        </div>
      </div>
    </button>
  );
}

export function ThemePicker({
  value,
  onChange,
}: {
  value: Theme;
  onChange: (value: Theme) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"basic" | "custom">("basic");
  const [animating, setAnimating] = useState(false);

  const selectedOption = [...BASIC_THEME_OPTIONS, ...CUSTOM_THEME_OPTIONS].find(
    (opt) => opt.value === value,
  );

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  // Lock body scroll when open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  const handleOpen = () => {
    setAnimating(true);
    setIsOpen(true);
    requestAnimationFrame(() => setAnimating(false));
  };

  const handleSelect = (newValue: Theme) => {
    onChange(newValue);
    setIsOpen(false);
  };

  return (
    <>
      {/* Trigger - Large clickable card */}
      <button
        type="button"
        onClick={handleOpen}
        className="group relative mb-1 w-full overflow-hidden rounded-xl border-2 border-border/60 bg-background p-0 text-left transition-all duration-300 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5 active:scale-[0.99] sm:w-auto sm:min-w-[20rem]"
      >
        <div className="absolute inset-0 bg-gradient-to-r from-primary/5 via-accent/5 to-primary/5 opacity-0 transition-opacity duration-500 group-hover:opacity-100" />

        <div className="relative flex items-center gap-0">
          {/* Color strip */}
          {selectedOption ? (
            <div className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden sm:h-16 sm:w-16">
              <div
                className="absolute inset-0"
                style={{ backgroundColor: selectedOption.colors.background }}
              />
              <div className="absolute bottom-0 left-0 right-0 h-1/2 bg-gradient-to-t from-black/20 to-transparent" />
              {/* Mini preview blocks */}
              <div className="relative flex flex-col gap-1 p-2">
                <div
                  className="h-1.5 w-8 rounded-full"
                  style={{ backgroundColor: selectedOption.colors.primary }}
                />
                <div className="flex gap-1">
                  <div
                    className="h-1.5 w-5 rounded-full"
                    style={{ backgroundColor: selectedOption.colors.foreground }}
                  />
                  <div
                    className="h-1.5 w-3 rounded-full"
                    style={{ backgroundColor: selectedOption.colors.accent }}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-14 w-14 shrink-0 items-center justify-center bg-muted sm:h-16 sm:w-16">
              <PaletteIcon className="size-6 text-muted-foreground" />
            </div>
          )}

          {/* Text content */}
          <div className="flex flex-1 flex-col px-4 py-3">
            <span className="text-sm font-semibold text-foreground sm:text-base">
              {selectedOption?.label ?? "Select Theme"}
            </span>
            <span className="text-xs text-muted-foreground sm:text-sm">
              {selectedOption?.description ?? "Choose a theme for your interface"}
            </span>
          </div>

          {/* Arrow / edit indicator */}
          <div className="flex shrink-0 items-center self-center px-4">
            <div className="flex size-8 items-center justify-center rounded-full bg-muted transition-colors group-hover:bg-primary/10">
              <svg
                className="size-4 text-muted-foreground transition-colors group-hover:text-primary"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </div>
          </div>
        </div>
      </button>

      {/* Modal overlay */}
      {isOpen ? (
        <div
          className={cn(
            "fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto overflow-x-hidden",
            "bg-black/40 backdrop-blur-sm transition-all duration-300",
            animating ? "opacity-0" : "opacity-100",
          )}
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsOpen(false);
          }}
        >
          <div
            className={cn(
              "relative my-4 flex w-full max-w-[min(56rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border/50 bg-background shadow-2xl transition-all duration-300 sm:my-8",
              animating ? "scale-95 opacity-0" : "scale-100 opacity-100",
            )}
          >
            {/* Header */}
            <div className="relative flex items-start justify-between gap-4 border-b border-border/50 bg-muted/30 px-5 py-4 sm:px-6 sm:py-5">
              <div className="flex items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <PaletteIcon className="size-5" />
                </div>
                <div>
                  <h2 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
                    Choose Theme
                  </h2>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    Pick a theme that matches your style
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="mt-0.5 shrink-0 rounded-full hover:bg-muted"
                onClick={() => setIsOpen(false)}
              >
                <XIcon className="size-5" />
              </Button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-border/50 bg-muted/30 px-5 sm:px-6">
              {(
                [
                  { id: "basic", label: "Basic" },
                  { id: "custom", label: "Custom" },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "relative px-3 py-3 text-sm font-medium transition-colors sm:px-4",
                    activeTab === tab.id
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground/80",
                  )}
                >
                  {tab.label}
                  {activeTab === tab.id && (
                    <div className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-primary" />
                  )}
                </button>
              ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-6">
              {activeTab === "basic" ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {BASIC_THEME_OPTIONS.map((option) => (
                    <ThemeCard
                      key={option.value}
                      option={option}
                      isSelected={value === option.value}
                      onSelect={() => handleSelect(option.value)}
                    />
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                  {CUSTOM_THEME_OPTIONS.map((option) => (
                    <ThemeCard
                      key={option.value}
                      option={option}
                      isSelected={value === option.value}
                      onSelect={() => handleSelect(option.value)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-border/50 bg-muted/30 px-5 py-3 sm:px-6">
              <div className="flex items-center gap-2 text-xs text-muted-foreground sm:text-sm">
                <PaletteIcon className="size-3.5 sm:size-4" />
                <span>
                  {BASIC_THEME_OPTIONS.length + CUSTOM_THEME_OPTIONS.length} themes available
                </span>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => setIsOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
