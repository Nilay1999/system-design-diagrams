-- name: CreateSession :exec
INSERT INTO sessions (id_hash, user_id, expires_at, user_agent)
VALUES (@id_hash, @user_id, @expires_at, @user_agent);

-- name: GetSessionUser :one
SELECT sqlc.embed(users), sessions.expires_at
FROM sessions
JOIN users ON users.id = sessions.user_id
WHERE sessions.id_hash = @id_hash AND sessions.expires_at > now();

-- name: ExtendSession :exec
UPDATE sessions SET expires_at = @expires_at WHERE id_hash = @id_hash;

-- name: DeleteSession :exec
DELETE FROM sessions WHERE id_hash = @id_hash;

-- name: DeleteExpiredSessions :execrows
DELETE FROM sessions WHERE user_id = @user_id AND expires_at <= now();
