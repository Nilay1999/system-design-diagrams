// Package httpapi wires the generated API handlers into an http.Handler with the
// cross-cutting middleware (request IDs, access logs, panic recovery, CSRF, sessions,
// JSON errors).
package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"net/url"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/Nilay1999/system-design-diagrams/server/internal/api"
	"github.com/Nilay1999/system-design-diagrams/server/internal/github"
	"github.com/Nilay1999/system-design-diagrams/server/internal/store"
)

// Pinger is the part of the database pool the readiness probe needs.
type Pinger interface {
	Ping(ctx context.Context) error
}

// Store is the subset of the generated queries the handlers use.
type Store interface {
	UpsertGitHubUser(ctx context.Context, arg store.UpsertGitHubUserParams) (store.User, error)
	GetUserByHandle(ctx context.Context, handle string) (store.User, error)
	CreateSession(ctx context.Context, arg store.CreateSessionParams) error
	GetSessionUser(ctx context.Context, idHash []byte) (store.GetSessionUserRow, error)
	ExtendSession(ctx context.Context, arg store.ExtendSessionParams) error
	DeleteSession(ctx context.Context, idHash []byte) error
	DeleteExpiredSessions(ctx context.Context, userID int64) (int64, error)
}

// GitHub is the OAuth side of sign-in (*github.Client in production).
type GitHub interface {
	AuthCodeURL(state, verifier string) string
	FetchUser(ctx context.Context, code, verifier string) (github.User, error)
}

// Deps are the Server's collaborators and settings.
type Deps struct {
	Logger *slog.Logger
	DB     Pinger
	Store  Store
	// GitHub is nil when sign-in isn't configured.
	GitHub GitHub
	// PublicURL is the origin browsers use; it is trusted for CSRF and decides Secure cookies.
	PublicURL      *url.URL
	AdminGitHubIDs map[int64]bool
	SessionTTL     time.Duration
	Version        string
	// Now defaults to time.Now.
	Now func() time.Time
}

// Server implements the generated API interface.
type Server struct {
	Deps
	secureCookies bool
	draining      atomic.Bool
}

// New returns a Server.
func New(d Deps) *Server {
	if d.Now == nil {
		d.Now = time.Now
	}
	return &Server{Deps: d, secureCookies: d.PublicURL.Scheme == "https"}
}

// Drain makes /ready report 503 so the load balancer stops sending new requests
// before the listener shuts down.
func (s *Server) Drain() { s.draining.Store(true) }

// Handler returns the full HTTP handler, with the API mounted under /api.
func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(withRequestID, withRecover(s.Logger), withAccessLog(s.Logger), s.withCSRFProtection, s.withSession)
	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, r, http.StatusNotFound, "not found")
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, r, http.StatusMethodNotAllowed, "method not allowed")
	})

	strict := api.NewStrictHandlerWithOptions(s, nil, api.StrictHTTPServerOptions{
		RequestErrorHandlerFunc:  requestError,
		ResponseErrorHandlerFunc: responseError(s.Logger),
	})
	return api.HandlerWithOptions(strict, api.ChiServerOptions{
		BaseURL:          "/api",
		BaseRouter:       r,
		ErrorHandlerFunc: requestError,
	})
}

// withCSRFProtection rejects cross-site state-changing requests (POST, PUT, …) using the
// browser's Sec-Fetch-Site / Origin headers. Safe methods and non-browser clients pass.
// The cookie is SameSite=Lax too; this covers same-site-but-cross-origin requests as well.
func (s *Server) withCSRFProtection(next http.Handler) http.Handler {
	cop := http.NewCrossOriginProtection()
	// Behind the Vercel rewrite the API's own Host differs from the origin browsers use.
	origin := s.PublicURL.Scheme + "://" + s.PublicURL.Host
	if err := cop.AddTrustedOrigin(origin); err != nil {
		panic(err) // config.Load already validated PUBLIC_URL
	}
	cop.SetDenyHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, r, http.StatusForbidden, "cross-origin request rejected")
	}))
	return cop.Handler(next)
}

var _ api.StrictServerInterface = (*Server)(nil)
