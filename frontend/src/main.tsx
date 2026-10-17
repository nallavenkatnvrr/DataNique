import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { ThemeProvider, useTheme } from "@/context/ThemeContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { VaultGate } from "@/components/vault/VaultGate";
import App from "./App";
import "./index.css";
import { applyEffects } from "@/lib/effects";

applyEffects();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: (count, err: any) => count < 1 && ![401, 403, 404, 423].includes(err?.status),
      staleTime: 30_000,
    },
  },
});

// Electron / file:// builds can't use the history API.
const isDesktop = typeof window !== "undefined" && Boolean((window as any).__API_BASE__);
const Router = isDesktop ? HashRouter : BrowserRouter;

function ThemedToaster() {
  const { resolved } = useTheme();
  return <Toaster position="bottom-right" theme={resolved} richColors closeButton />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <Router>
            <VaultGate>
              <App />
            </VaultGate>
            <ThemedToaster />
          </Router>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
