import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "./client";
import type { components } from "./schema";

export type User = components["schemas"]["User"];

const meKey = ["me"] as const;

/**
 * The signed-in user, or `null` when signed out. Rejects when the API isn't reachable
 * (for example a static deploy without the backend), so callers can hide account UI.
 */
export async function fetchMe(): Promise<User | null> {
  try {
    return await api.get<User>("/me");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export function useMe() {
  return useQuery({ queryKey: meKey, queryFn: fetchMe, retry: false, staleTime: 5 * 60_000 });
}

export function useSignOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>("/auth/logout"),
    onSuccess: () => queryClient.setQueryData(meKey, null),
  });
}

export function useUser(handle: string) {
  return useQuery({
    queryKey: ["user", handle.toLowerCase()],
    queryFn: () => api.get<User>(`/users/${encodeURIComponent(handle)}`),
  });
}

/** Full-page navigation into the OAuth flow; the API sends the browser back to `returnTo`. */
export function signInUrl(returnTo: string) {
  return `/api/auth/github/login?returnTo=${encodeURIComponent(returnTo)}`;
}

/** The API redirects back with `?signInError=<reason>` when sign-in fails. */
export const SIGN_IN_ERROR_PARAM = "signInError";

const SIGN_IN_ERRORS: Record<string, string> = {
  denied: "Sign-in was cancelled on GitHub.",
  state: "That sign-in link expired or was opened in another tab. Please try again.",
  github: "GitHub didn't confirm the sign-in. Please try again.",
  server: "Something went wrong while signing you in. Please try again.",
};

export function signInErrorMessage(reason: string | null): string | undefined {
  if (reason === null) return undefined;
  return SIGN_IN_ERRORS[reason] ?? SIGN_IN_ERRORS.server;
}
