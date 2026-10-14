-- name: UpsertGitHubUser :one
-- Called on every sign-in so the profile follows GitHub. promote_admin only ever raises the
-- role; it never demotes a moderator or admin.
INSERT INTO users (github_id, handle, name, avatar_url, role)
VALUES (@github_id, @handle, @name, @avatar_url,
        CASE WHEN @promote_admin::bool THEN 'admin' ELSE 'user' END)
ON CONFLICT (github_id) DO UPDATE
SET handle     = EXCLUDED.handle,
    name       = EXCLUDED.name,
    avatar_url = EXCLUDED.avatar_url,
    role       = CASE WHEN @promote_admin::bool THEN 'admin' ELSE users.role END,
    updated_at = now()
RETURNING *;

-- name: GetUserByHandle :one
SELECT * FROM users WHERE handle = @handle;
