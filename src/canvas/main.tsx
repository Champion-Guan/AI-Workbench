import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "./styles/globals.css";
import { RouterProvider } from "react-router-dom";

import { AppProviders } from "@/components/layout/app-providers";
import "@/i18n";
import { initAnalytics } from "@/lib/analytics";
import { router } from "@/router";
import { initProductRecycleBridge } from '@/services/product-recycle-bridge';
import { startUpdateActivityReporter } from '@/services/update-activity-reporter';
import { startManagedPageRelay } from '@/services/managed-page-relay';

initAnalytics();
initProductRecycleBridge();
const stopUpdateActivityReporter = startUpdateActivityReporter();
if (import.meta.hot) import.meta.hot.dispose(stopUpdateActivityReporter);
const stopManagedPageRelay = startManagedPageRelay();
if (import.meta.hot) import.meta.hot.dispose(stopManagedPageRelay);

document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <AppProviders>
            <RouterProvider router={router} />
        </AppProviders>
    </React.StrictMode>,
);
