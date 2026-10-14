package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type fakeDB struct{ err error }

func (f fakeDB) Ping(context.Context) error { return f.err }

func newTestServer(db Pinger) (*Server, *bytes.Buffer) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	return New(Deps{
		Logger:     logger,
		DB:         db,
		Store:      newFakeStore(),
		PublicURL:  &url.URL{Scheme: "https", Host: "sdd.example"},
		SessionTTL: 30 * 24 * time.Hour,
		Version:    "test-sha",
	}), &logs
}

func do(t *testing.T, h http.Handler, method, path string, header http.Header) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	for k, v := range header {
		req.Header[k] = v
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("%s %s: body is not JSON: %q", method, path, rec.Body.String())
	}
	return rec, body
}

func TestHealth(t *testing.T) {
	s, _ := newTestServer(fakeDB{err: errors.New("down")})
	rec, body := do(t, s.Handler(), http.MethodGet, "/api/health", nil)
	// Liveness must not depend on the database.
	if rec.Code != http.StatusOK || body["status"] != "ok" || body["version"] != "test-sha" {
		t.Fatalf("got %d %v", rec.Code, body)
	}
}

func TestReady(t *testing.T) {
	cases := []struct {
		name   string
		dbErr  error
		drain  bool
		code   int
		checks map[string]any
	}{
		{"ok", nil, false, 200, map[string]any{"database": "ok"}},
		{"db down", errors.New("refused"), false, 503, map[string]any{"database": "unreachable"}},
		{"draining", nil, true, 503, map[string]any{"database": "ok", "server": "draining"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := newTestServer(fakeDB{err: tc.dbErr})
			if tc.drain {
				s.Drain()
			}
			rec, body := do(t, s.Handler(), http.MethodGet, "/api/ready", nil)
			if rec.Code != tc.code {
				t.Fatalf("status %d, want %d", rec.Code, tc.code)
			}
			checks, _ := body["checks"].(map[string]any)
			if len(checks) != len(tc.checks) {
				t.Fatalf("checks %v, want %v", checks, tc.checks)
			}
			for k, v := range tc.checks {
				if checks[k] != v {
					t.Fatalf("checks %v, want %v", checks, tc.checks)
				}
			}
		})
	}
}

func TestNotFoundAndMethodNotAllowedAreJSON(t *testing.T) {
	s, _ := newTestServer(fakeDB{})
	h := s.Handler()

	rec, body := do(t, h, http.MethodGet, "/api/nope", nil)
	if rec.Code != 404 || body["message"] != "not found" || body["requestId"] == "" {
		t.Fatalf("got %d %v", rec.Code, body)
	}
	rec, body = do(t, h, http.MethodPost, "/api/health", nil)
	if rec.Code != 405 || body["message"] != "method not allowed" {
		t.Fatalf("got %d %v", rec.Code, body)
	}
}

func TestRequestID(t *testing.T) {
	s, logs := newTestServer(fakeDB{})
	h := s.Handler()

	rec, _ := do(t, h, http.MethodGet, "/api/health", http.Header{"X-Request-Id": {"upstream-123"}})
	if got := rec.Header().Get("X-Request-Id"); got != "upstream-123" {
		t.Fatalf("upstream ID not reused: %q", got)
	}
	if !strings.Contains(logs.String(), `"request_id":"upstream-123"`) {
		t.Fatalf("request ID missing from access log: %s", logs.String())
	}

	rec, _ = do(t, h, http.MethodGet, "/api/health", http.Header{"X-Request-Id": {"bad id\nwith newline"}})
	if got := rec.Header().Get("X-Request-Id"); len(got) != 24 || strings.ContainsAny(got, " \n") {
		t.Fatalf("unsafe upstream ID should be replaced, got %q", got)
	}
}

func TestRecoverReturnsJSON500(t *testing.T) {
	s, logs := newTestServer(fakeDB{})
	h := withRequestID(withRecover(s.Logger)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	})))
	rec, body := do(t, h, http.MethodGet, "/x", nil)
	if rec.Code != 500 || body["message"] != "internal server error" {
		t.Fatalf("got %d %v", rec.Code, body)
	}
	if !strings.Contains(logs.String(), "boom") {
		t.Fatal("panic not logged")
	}
}
