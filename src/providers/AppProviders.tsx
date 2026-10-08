import type { ReactNode } from "react";
import { BrowserRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";

import { queryClient } from "../api/queryClient";
import { ThemeProvider } from "../theme/ThemeProvider";

/** Every app-wide provider, in one place, so `main.tsx` and future tests mount the same tree. */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>{children}</ThemeProvider>
      </QueryClientProvider>
    </BrowserRouter>
  );
}
