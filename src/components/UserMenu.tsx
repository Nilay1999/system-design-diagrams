import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";

import { SIGN_IN_ERROR_PARAM, signInErrorMessage, signInUrl, useMe, useSignOut, type User } from "../api/auth";

/**
 * "Sign in with GitHub", or the signed-in user's avatar and menu. Renders nothing while
 * loading or when the API isn't reachable, so the static site looks the same without it.
 */
export function UserMenu() {
  const me = useMe();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const error = signInErrorMessage(params.get(SIGN_IN_ERROR_PARAM));

  const dismissError = () =>
    setParams(
      (p) => {
        p.delete(SIGN_IN_ERROR_PARAM);
        return p;
      },
      { replace: true },
    );

  const returnParams = new URLSearchParams(params);
  returnParams.delete(SIGN_IN_ERROR_PARAM);
  const query = returnParams.toString();
  const returnTo = location.pathname + (query ? `?${query}` : "") + location.hash;

  return (
    <>
      {error && (
        <div className="signin-error" role="alert">
          <span>{error}</span>
          <button onClick={dismissError} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {me.data === null && (
        <a className="button" href={signInUrl(returnTo)}>
          Sign in with GitHub
        </a>
      )}
      {me.data && <AccountMenu user={me.data} />}
    </>
  );
}

function AccountMenu({ user }: { user: User }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const signOut = useSignOut();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="user-menu" ref={ref}>
      <button
        className="avatar-button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Signed in as @${user.handle}`}
      >
        <Avatar user={user} size={30} />
      </button>
      {open && (
        <div className="menu-popover" role="menu">
          <div className="menu-identity">
            <strong>{user.name || user.handle}</strong>
            <span>@{user.handle}</span>
          </div>
          <Link role="menuitem" to={`/u/${user.handle}`} onClick={() => setOpen(false)}>
            Your profile
          </Link>
          <button role="menuitem" onClick={() => signOut.mutate(undefined, { onSuccess: () => setOpen(false) })} disabled={signOut.isPending}>
            Sign out
          </button>
          {signOut.isError && <p className="form-error">Couldn't sign out. Please try again.</p>}
        </div>
      )}
    </div>
  );
}

export function Avatar({ user, size }: { user: User; size: number }) {
  if (!user.avatarUrl) {
    return (
      <span className="avatar avatar-fallback" style={{ width: size, height: size }} aria-hidden>
        {user.handle.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return <img className="avatar" src={user.avatarUrl} alt="" width={size} height={size} />;
}
