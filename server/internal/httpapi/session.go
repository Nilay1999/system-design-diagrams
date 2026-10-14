package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Nilay1999/system-design-diagrams/server/internal/store"
)

const sessionCookieName = "sdd_session"

type sessionKey struct{}
type userAgentKey struct{}

// session is the signed-in user for this request.
type session struct {
	user store.User
	hash []byte
}

func sessionFrom(ctx context.Context) *session {
	s, _ := ctx.Value(sessionKey{}).(*session)
	return s
}

// newToken returns 256 random bits, URL-safe.
func newToken() string {
	var b [32]byte
	_, _ = rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

func hashToken(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}

// withSession resolves the session cookie to a user. A session is extended (and the
// cookie re-sent) once less than half its lifetime is left, so active users stay signed
// in without a database write on every request.
func (s *Server) withSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), userAgentKey{}, r.UserAgent())
		c, err := r.Cookie(sessionCookieName)
		if err != nil || c.Value == "" {
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}

		hash := hashToken(c.Value)
		row, err := s.Store.GetSessionUser(ctx, hash)
		if errors.Is(err, pgx.ErrNoRows) {
			// Expired, signed out elsewhere, or forged: drop the stale cookie.
			http.SetCookie(w, s.expiredCookie(sessionCookieName, "/"))
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}
		if err != nil {
			// Carrying on signed-out would look like a sign-out to the user.
			s.Logger.ErrorContext(ctx, "session lookup failed", "err", err, "request_id", RequestID(ctx))
			writeError(w, r, http.StatusServiceUnavailable, "service temporarily unavailable")
			return
		}

		now := s.Now()
		if row.ExpiresAt.Sub(now) < s.SessionTTL/2 {
			err := s.Store.ExtendSession(ctx, store.ExtendSessionParams{IDHash: hash, ExpiresAt: now.Add(s.SessionTTL)})
			if err != nil {
				s.Logger.WarnContext(ctx, "extend session failed", "err", err, "request_id", RequestID(ctx))
			} else {
				http.SetCookie(w, s.cookie(sessionCookieName, c.Value, "/", s.SessionTTL))
			}
		}
		ctx = context.WithValue(ctx, sessionKey{}, &session{user: row.User, hash: hash})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// startSession stores a new session for the user and returns its cookie.
func (s *Server) startSession(ctx context.Context, userID int64) (*http.Cookie, error) {
	if _, err := s.Store.DeleteExpiredSessions(ctx, userID); err != nil {
		s.Logger.WarnContext(ctx, "delete expired sessions failed", "err", err)
	}
	ua, _ := ctx.Value(userAgentKey{}).(string)
	if len(ua) > 512 {
		ua = ua[:512]
	}
	token := newToken()
	err := s.Store.CreateSession(ctx, store.CreateSessionParams{
		IDHash:    hashToken(token),
		UserID:    userID,
		ExpiresAt: s.Now().Add(s.SessionTTL),
		UserAgent: ua,
	})
	if err != nil {
		return nil, err
	}
	return s.cookie(sessionCookieName, token, "/", s.SessionTTL), nil
}

// cookie is HttpOnly (no script access) and SameSite=Lax: sent on top-level navigations
// such as GitHub's redirect back, but not on cross-site subresource or form POSTs.
func (s *Server) cookie(name, value, path string, maxAge time.Duration) *http.Cookie {
	return &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     path,
		MaxAge:   int(maxAge.Seconds()),
		HttpOnly: true,
		Secure:   s.secureCookies,
		SameSite: http.SameSiteLaxMode,
	}
}

func (s *Server) expiredCookie(name, path string) *http.Cookie {
	c := s.cookie(name, "", path, 0)
	c.MaxAge = -1
	return c
}
