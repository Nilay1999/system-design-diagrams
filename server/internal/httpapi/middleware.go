package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"runtime/debug"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

const requestIDHeader = "X-Request-Id"

type requestIDKey struct{}

// An upstream ID (from the Vercel proxy or a client) is reused only if it looks harmless,
// since it ends up in logs and response headers.
var validRequestID = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

// RequestID returns the request's ID, or "" outside a request.
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

// withRequestID assigns every request an ID, echoes it in the response and stores it in
// the context for logs and error bodies.
func withRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(requestIDHeader)
		if !validRequestID.MatchString(id) {
			id = newRequestID()
		}
		w.Header().Set(requestIDHeader, id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey{}, id)))
	})
}

func newRequestID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// probePaths are polled every few seconds by the platform, so they log at debug level.
var probePaths = map[string]bool{"/api/health": true, "/api/ready": true}

// withAccessLog writes one structured line per request.
func withAccessLog(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			next.ServeHTTP(ww, r)

			level := slog.LevelInfo
			switch {
			case ww.Status() >= 500:
				level = slog.LevelError
			case probePaths[r.URL.Path]:
				level = slog.LevelDebug
			}
			logger.LogAttrs(r.Context(), level, "request",
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.Int("status", ww.Status()),
				slog.Int("bytes", ww.BytesWritten()),
				slog.Duration("duration", time.Since(start)),
				slog.String("request_id", RequestID(r.Context())),
			)
		})
	}
}

// withRecover turns a panic into a logged 500 instead of a dropped connection.
func withRecover(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				rec := recover()
				if rec == nil {
					return
				}
				if err, ok := rec.(error); ok && errors.Is(err, http.ErrAbortHandler) {
					panic(rec)
				}
				logger.ErrorContext(r.Context(), "panic", "panic", rec,
					"stack", string(debug.Stack()), "request_id", RequestID(r.Context()))
				writeError(w, r, http.StatusInternalServerError, "internal server error")
			}()
			next.ServeHTTP(w, r)
		})
	}
}
