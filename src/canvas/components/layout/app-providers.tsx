import type { ReactNode } from "react";
import { useEffect } from "react";
import { flushSync } from "react-dom";
import { ProConfigProvider } from "@ant-design/pro-components";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, ConfigProvider } from "antd";
import enUS from "antd/es/locale/en_US";
import zhCN from "antd/es/locale/zh_CN";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import { useTranslation } from "react-i18next";

import { ClientRootInit } from "@/components/layout/client-root-init";
import type { AppLocale } from "@/i18n";
import { getAntThemeConfig } from "@/lib/app-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useConfigStore } from "@/stores/use-config-store";

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 30_000,
            retry: false,
            refetchOnWindowFocus: false,
        },
    },
});

export function AppProviders({ children }: { children: ReactNode }) {
    const { i18n, t } = useTranslation();
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const dark = theme === "dark";
    const locale = i18n.resolvedLanguage as AppLocale;

    useEffect(() => {
        let settingsOpenRequestId = 0;
        const handleSettingsOpen = async (event: MessageEvent) => {
            if (event.origin !== location.origin || event.source !== window.parent) return;
            if (event.data?.type === "guan-global-settings-close") {
                settingsOpenRequestId += 1;
                // Remove the portal now: hidden frames can pause exit animations
                // and otherwise resume them when the product becomes visible.
                flushSync(() => useConfigStore.getState().closeConfigDialogImmediately());
                return;
            }
            if (event.data?.type !== "guan-global-settings-open") return;
            const requestId = ++settingsOpenRequestId;
            // Cached product frames must read the shared configuration rather
            // than keep a stale copy of another product's settings.
            await useConfigStore.persist.rehydrate();
            if (requestId !== settingsOpenRequestId) return;
            useConfigStore.getState().openConfigDialog();
            window.parent.postMessage({ type: "guan-global-settings-opened" }, location.origin);
        };
        window.addEventListener("message", handleSettingsOpen);
        if (window.parent !== window) window.parent.postMessage({ type: "guan-global-settings-ready" }, location.origin);
        return () => {
            window.removeEventListener("message", handleSettingsOpen);
        };
    }, []);

    useEffect(() => {
        document.documentElement.classList.toggle("dark", dark);
        document.documentElement.style.colorScheme = theme;
    }, [dark, theme]);

    useEffect(() => {
        const handleThemeSync = (event: MessageEvent) => {
            if (event.origin !== location.origin || event.source !== window.parent) return;
            const nextTheme = event.data?.type === "guan-theme-sync" ? event.data.theme : "";
            if ((nextTheme === "light" || nextTheme === "dark") && useThemeStore.getState().theme !== nextTheme) setTheme(nextTheme);
        };
        const handleThemeApply = (event: Event) => {
            const nextTheme = (event as CustomEvent<{ theme?: string }>).detail?.theme;
            if ((nextTheme === "light" || nextTheme === "dark") && useThemeStore.getState().theme !== nextTheme) {
                flushSync(() => setTheme(nextTheme));
            }
        };
        window.addEventListener("message", handleThemeSync);
        window.addEventListener("guan-theme-apply", handleThemeApply);
        return () => {
            window.removeEventListener("message", handleThemeSync);
            window.removeEventListener("guan-theme-apply", handleThemeApply);
        };
    }, [setTheme]);

    useEffect(() => {
        document.documentElement.lang = locale;
        document.title = t("meta.title");
        document.querySelector('meta[name="description"]')?.setAttribute("content", t("meta.description"));
        dayjs.locale(locale === "zh-CN" ? "zh-cn" : "en");
    }, [locale, t]);

    return (
        <ConfigProvider locale={locale === "zh-CN" ? zhCN : enUS} theme={getAntThemeConfig(dark)}>
            <ProConfigProvider dark={dark}>
                <App>
                    <QueryClientProvider client={queryClient}>
                        <ClientRootInit>{children}</ClientRootInit>
                    </QueryClientProvider>
                </App>
            </ProConfigProvider>
        </ConfigProvider>
    );
}
