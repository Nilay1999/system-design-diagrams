package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/Nilay1999/system-design-diagrams/server/internal/api"
)

// writeError sends the API's error shape. The web client reads `message` from it.
func writeError(w http.ResponseWriter, r *http.Request, status int, message string) {
	id := RequestID(r.Context())
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(api.Error{Message: message, RequestId: &id})
}

// apiError is the body for typed error responses returned by strict handlers.
func apiError(ctx context.Context, message string) api.Error {
	id := RequestID(ctx)
	return api.Error{Message: message, RequestId: &id}
}

// requestError handles input the generated router could not bind (bad params, bad JSON).
func requestError(w http.ResponseWriter, r *http.Request, err error) {
	writeError(w, r, http.StatusBadRequest, err.Error())
}

// responseError handles an error returned by a handler. Its text is logged, not sent:
// handlers return typed responses for every error the client is meant to see.
func responseError(logger *slog.Logger) func(http.ResponseWriter, *http.Request, error) {
	return func(w http.ResponseWriter, r *http.Request, err error) {
		logger.ErrorContext(r.Context(), "handler error", "err", err, "request_id", RequestID(r.Context()))
		writeError(w, r, http.StatusInternalServerError, "internal server error")
	}
}
