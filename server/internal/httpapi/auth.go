package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/oauth2"

	"github.com/Nilay1999/system-design-diagrams/server/internal/api"
	"github.com/Nilay1999/system-design-diagrams/server/internal/github"
	"github.com/Nilay1999/system-design-diagrams/server/internal/store"
)

const (
	oauthCookieName = "sdd_oauth"
	// Scoped to the callback's path so it isn't sent anywhere else.
	oauthCookiePath = "/api/auth/github"
	oauthCookieTTL  = 10 * time.Minute
)

// oauthState lives in the short-lived sdd_oauth cookie between login and callback. Only
// this browser holds it, which is what ties the callback to the browser that started.
type oauthState struct {
	State    string `json:"s"`
	Verifier string `json:"v"`
	ReturnTo string `json:"r"`
}

func encodeOAuthState(st oauthState) string {
	b, _ := json.Marshal(st)
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeOAuthState(v *string) (oauthState, bool) {
	var st oauthState
	if v == nil {
		return st, false
	}
	b, err := base64.RawURLEncoding.DecodeString(*v)
	if err != nil || json.Unmarshal(b, &st) != nil || st.State == "" || st.Verifier == "" {
		return oauthState{}, false
	}
	st.ReturnTo = safeReturnTo(&st.ReturnTo)
	return st, true
}

// safeReturnTo keeps redirects on this site: a path, not "//evil.com" or "/\evil.com"
// (which browsers treat as another host), and not back into the API.
func safeReturnTo(p *string) string {
	if p == nil {
		return "/"
	}
	v := *p
	if !strings.HasPrefix(v, "/") || strings.HasPrefix(v, "//") || strings.HasPrefix(v, "/\\") ||
		strings.ContainsFunc(v, unicode.IsControl) {
		return "/"
	}
	u, err := url.Parse(v)
	if err != nil || u.Scheme != "" || u.Host != "" || u.Path == "/api" || strings.HasPrefix(u.Path, "/api/") {
		return "/"
	}
	return v
}

// withQuery adds key=value to a same-site path's query string.
func withQuery(path, key, value string) string {
	u, err := url.Parse(path)
	if err != nil {
		return "/?" + url.Values{key: {value}}.Encode()
	}
	q := u.Query()
	q.Set(key, value)
	u.RawQuery = q.Encode()
	return u.String()
}

// GithubLogin starts the OAuth flow.
func (s *Server) GithubLogin(ctx context.Context, req api.GithubLoginRequestObject) (api.GithubLoginResponseObject, error) {
	if s.GitHub == nil {
		return api.GithubLogin503JSONResponse(apiError(ctx, "GitHub sign-in isn't configured on this server")), nil
	}
	st := oauthState{State: newToken(), Verifier: oauth2.GenerateVerifier(), ReturnTo: safeReturnTo(req.Params.ReturnTo)}
	return redirect{
		location: s.GitHub.AuthCodeURL(st.State, st.Verifier),
		cookies:  []*http.Cookie{s.cookie(oauthCookieName, encodeOAuthState(st), oauthCookiePath, oauthCookieTTL)},
	}, nil
}

// GithubCallback finishes the OAuth flow: checks state, fetches the GitHub user, upserts
// them and starts a session. Failures redirect back with ?signInError=<reason>.
func (s *Server) GithubCallback(ctx context.Context, req api.GithubCallbackRequestObject) (api.GithubCallbackResponseObject, error) {
	clearState := s.expiredCookie(oauthCookieName, oauthCookiePath)
	st, ok := decodeOAuthState(req.Params.SddOauth)
	returnTo := "/"
	if ok {
		returnTo = st.ReturnTo
	}
	fail := func(reason string) (api.GithubCallbackResponseObject, error) {
		return redirect{location: withQuery(returnTo, "signInError", reason), cookies: []*http.Cookie{clearState}}, nil
	}

	switch {
	case s.GitHub == nil:
		return fail("server")
	case req.Params.Error != nil:
		return fail("denied")
	case !ok || req.Params.State == nil || req.Params.Code == nil ||
		subtle.ConstantTimeCompare([]byte(*req.Params.State), []byte(st.State)) != 1:
		return fail("state")
	}

	gh, err := s.GitHub.FetchUser(ctx, *req.Params.Code, st.Verifier)
	if err != nil {
		s.Logger.WarnContext(ctx, "github sign-in failed", "err", err, "request_id", RequestID(ctx))
		return fail("github")
	}
	user, err := s.upsertUser(ctx, gh)
	if err != nil {
		s.Logger.ErrorContext(ctx, "upsert user failed", "err", err, "github_id", gh.ID, "request_id", RequestID(ctx))
		return fail("server")
	}
	sessionCookie, err := s.startSession(ctx, user.ID)
	if err != nil {
		s.Logger.ErrorContext(ctx, "create session failed", "err", err, "user_id", user.ID, "request_id", RequestID(ctx))
		return fail("server")
	}
	s.Logger.InfoContext(ctx, "signed in", "user_id", user.ID, "handle", user.Handle, "request_id", RequestID(ctx))
	return redirect{location: returnTo, cookies: []*http.Cookie{clearState, sessionCookie}}, nil
}

// upsertUser creates or refreshes the user. If their login is already taken by another
// account (one that held it before a GitHub rename), they get "<login>-<github id>".
func (s *Server) upsertUser(ctx context.Context, gh github.User) (store.User, error) {
	params := store.UpsertGitHubUserParams{
		GithubID:     gh.ID,
		Handle:       gh.Login,
		Name:         gh.Name,
		AvatarUrl:    gh.AvatarURL,
		PromoteAdmin: s.AdminGitHubIDs[gh.ID],
	}
	u, err := s.Store.UpsertGitHubUser(ctx, params)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "users_handle_key" {
		params.Handle = fmt.Sprintf("%s-%d", gh.Login, gh.ID)
		u, err = s.Store.UpsertGitHubUser(ctx, params)
	}
	return u, err
}

// Logout deletes the current session and clears the cookie. It succeeds when signed out too.
func (s *Server) Logout(ctx context.Context, _ api.LogoutRequestObject) (api.LogoutResponseObject, error) {
	if sess := sessionFrom(ctx); sess != nil {
		if err := s.Store.DeleteSession(ctx, sess.hash); err != nil {
			return nil, fmt.Errorf("delete session: %w", err)
		}
	}
	return noContent{cookies: []*http.Cookie{s.expiredCookie(sessionCookieName, "/")}}, nil
}
