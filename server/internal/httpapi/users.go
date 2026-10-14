package httpapi

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/Nilay1999/system-design-diagrams/server/internal/api"
	"github.com/Nilay1999/system-design-diagrams/server/internal/store"
)

func toAPIUser(u store.User) api.User {
	return api.User{
		Handle:     u.Handle,
		Name:       u.Name,
		AvatarUrl:  u.AvatarUrl,
		Role:       api.UserRole(u.Role),
		Reputation: u.Reputation,
		CreatedAt:  u.CreatedAt,
	}
}

// GetMe returns the signed-in user.
func (s *Server) GetMe(ctx context.Context, _ api.GetMeRequestObject) (api.GetMeResponseObject, error) {
	sess := sessionFrom(ctx)
	if sess == nil {
		return api.GetMe401JSONResponse(apiError(ctx, "not signed in")), nil
	}
	return api.GetMe200JSONResponse(toAPIUser(sess.user)), nil
}

// GetUser returns a public profile by handle.
func (s *Server) GetUser(ctx context.Context, req api.GetUserRequestObject) (api.GetUserResponseObject, error) {
	u, err := s.Store.GetUserByHandle(ctx, req.Handle)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.GetUser404JSONResponse(apiError(ctx, "user not found")), nil
	}
	if err != nil {
		return nil, fmt.Errorf("get user %q: %w", req.Handle, err)
	}
	return api.GetUser200JSONResponse(toAPIUser(u)), nil
}
