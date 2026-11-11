"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";

import { cn } from "@/lib/utils";
import { SettingsSection } from "@/components/page";

const OPTIONS = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
] as const;

export function ThemeCard() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // next-themes hydration: rendered theme is null until mounted, so options
  // would all look inactive on first paint. Defer the active-styling until
  // after mount to avoid the flash + the hydration mismatch warning.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  // The description says what makes this one different from every other group
  // on /settings: it is a browser preference, not an account setting.
  return (
    <SettingsSection title="Appearance" description="This browser only.">
      <div className="grid max-w-sm grid-cols-3 gap-2">
          {OPTIONS.map(({ value, label, Icon }) => {
            const active = mounted && theme === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setTheme(value)}
                className={cn(
                  "flex items-center justify-center gap-2 rounded-md border bg-background px-3 py-2 text-sm transition-colors",
                  active
                    ? "border-foreground/40 bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                )}
                aria-pressed={active}
              >
                <Icon className="size-4" />
                {label}
              </button>
            );
          })}
      </div>
    </SettingsSection>
  );
}
