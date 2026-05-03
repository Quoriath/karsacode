export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center" aria-label="KarsaCode splash screen">
        <div className="relative flex size-20 items-center justify-center">
          <img
            alt="KarsaCode"
            className="size-14 object-contain animate-[pulse-subtle_1.8s_ease-in-out_infinite]"
            src="/apple-touch-icon.png"
          />
        </div>
        <div className="mt-4 text-lg font-semibold tracking-wide text-foreground animate-[fade-in-up_0.6s_ease-out_both_0.2s]">
          KarsaCode
        </div>
      </div>
    </div>
  );
}
