import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createCheckpointJsonStorage } from "@/lib/checkpoint-json-storage";

export type ThemeName = "light" | "dark";

type ThemeStore = {
    theme: ThemeName;
    setTheme: (theme: ThemeName) => void;
};

export const useThemeStore = create<ThemeStore>()(
    persist(
        (set) => ({
            theme: "dark",
            setTheme: (theme) => {
                set({ theme });
                // The canvas can be embedded in the workbench shell. User
                // choices must update the shell as well as this theme store.
                if (typeof window !== "undefined" && window.parent !== window) {
                    window.parent.postMessage({ type: "guan-theme-change", theme }, window.location.origin);
                }
            },
        }),
        { name: "infinite-canvas:theme_store", storage: createCheckpointJsonStorage(() => localStorage) },
    ),
);
