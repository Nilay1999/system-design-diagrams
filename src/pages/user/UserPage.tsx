import { useParams } from "react-router";

import { useMe, useUser } from "../../api/auth";
import { ApiError } from "../../api/client";
import { Avatar } from "../../components/UserMenu";
import { AppShell } from "../../layout/AppShell";

const joined = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

/** `/u/:handle`: a community member's public profile. */
export function UserPage() {
  const { handle = "" } = useParams();
  const user = useUser(handle);
  const me = useMe();
  const isMe = !!me.data && me.data.handle.toLowerCase() === handle.toLowerCase();

  let body;
  if (user.isPending) {
    body = null;
  } else if (user.error) {
    // The API's 404 has a JSON body; a static host's 404 (no API deployed) doesn't.
    body = (
      <p className="empty">
        {user.error instanceof ApiError && user.error.status === 404 && user.error.body
          ? `There's no member called @${handle}.`
          : "Profiles need the community API, which isn't reachable right now."}
      </p>
    );
  } else {
    const u = user.data;
    body = (
      <section className="profile">
        <Avatar user={u} size={96} />
        <div className="profile-details">
          <h2>
            {u.name || u.handle}
            {u.role !== "user" && <span className="role-badge">{u.role}</span>}
          </h2>
          <p className="profile-handle">
            @{u.handle}
            {isMe && " · you"}
          </p>
          <dl className="profile-stats">
            <div>
              <dt>Reputation</dt>
              <dd>{u.reputation.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Member since</dt>
              <dd>{joined.format(new Date(u.createdAt))}</dd>
            </div>
          </dl>
        </div>
      </section>
    );
  }

  return (
    <AppShell
      heading={
        <div className="topic-heading">
          <h1>@{handle}</h1>
          <p>Community profile</p>
        </div>
      }
    >
      <div className="page-scroll">{body}</div>
    </AppShell>
  );
}
