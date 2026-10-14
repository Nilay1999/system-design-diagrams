package httpapi

import (
	"context"
	"time"

	"github.com/Nilay1999/system-design-diagrams/server/internal/api"
)

const readyCheckTimeout = 2 * time.Second

// GetHealth is the liveness probe. It never checks dependencies, so a database outage
// doesn't get the process restarted.
func (s *Server) GetHealth(context.Context, api.GetHealthRequestObject) (api.GetHealthResponseObject, error) {
	return api.GetHealth200JSONResponse{Status: api.HealthStatusOk, Version: s.Version}, nil
}

// GetReady is the readiness probe: the database answers and the server isn't draining.
func (s *Server) GetReady(ctx context.Context, _ api.GetReadyRequestObject) (api.GetReadyResponseObject, error) {
	checks := map[string]string{"database": "ok"}
	ready := true

	if s.draining.Load() {
		checks["server"] = "draining"
		ready = false
	}

	ctx, cancel := context.WithTimeout(ctx, readyCheckTimeout)
	defer cancel()
	if err := s.DB.Ping(ctx); err != nil {
		s.Logger.WarnContext(ctx, "readiness: database ping failed", "err", err)
		checks["database"] = "unreachable"
		ready = false
	}

	if !ready {
		return api.GetReady503JSONResponse{Status: api.ReadinessStatusUnavailable, Checks: checks}, nil
	}
	return api.GetReady200JSONResponse{Status: api.ReadinessStatusOk, Checks: checks}, nil
}
