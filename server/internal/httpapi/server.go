// Package httpapi wires the generated API handlers into an http.Handler with the
// cross-cutting middleware (request IDs, access logs, panic recovery, JSON errors).
package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"sync/atomic"

	"github.com/go-chi/chi/v5"

	"github.com/Nilay1999/system-design-diagrams/server/internal/api"
)

// Pinger is the part of the database pool the readiness probe needs.
type Pinger interface {
	Ping(ctx context.Context) error
}

// Server implements the generated API interface.
type Server struct {
	logger   *slog.Logger
	db       Pinger
	version  string
	draining atomic.Bool
}

// New returns a Server. version is reported by /api/health.
func New(logger *slog.Logger, db Pinger, version string) *Server {
	return &Server{logger: logger, db: db, version: version}
}

// Drain makes /ready report 503 so the load balancer stops sending new requests
// before the listener shuts down.
func (s *Server) Drain() { s.draining.Store(true) }

// Handler returns the full HTTP handler, with the API mounted under /api.
func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(withRequestID, withRecover(s.logger), withAccessLog(s.logger))
	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, r, http.StatusNotFound, "not found")
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, r, http.StatusMethodNotAllowed, "method not allowed")
	})

	strict := api.NewStrictHandlerWithOptions(s, nil, api.StrictHTTPServerOptions{
		RequestErrorHandlerFunc:  requestError,
		ResponseErrorHandlerFunc: responseError(s.logger),
	})
	return api.HandlerWithOptions(strict, api.ChiServerOptions{
		BaseURL:          "/api",
		BaseRouter:       r,
		ErrorHandlerFunc: requestError,
	})
}

var _ api.StrictServerInterface = (*Server)(nil)
