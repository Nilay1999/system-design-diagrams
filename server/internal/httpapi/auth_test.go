package httpapi

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Nilay1999/system-design-diagrams/server/internal/github"
)

type authEnv struct {
	t      *testing.T
	server *Server
	store  *fakeStore
	gh     *fakeGitHub
	h      http.Handler
	now    time.Time
}

func newAuthEnv(t *testing.T) *authEnv {
	t.Helper()
	e := &authEnv{t: t, store: newFakeStore(), now: time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)}
	e.store.now = func() time.Time { return e.now }
	e.gh = &fakeGitHub{user: github.User{ID: 42, Login: "octocat", Name: "Octo Cat", AvatarURL: "https://a/42"}}
	e.server = New(Deps{
		Logger:         slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)),
		DB:             fakeDB{},
		Store:          e.store,
		GitHub:         e.gh,
		PublicURL:      &url.URL{Scheme: "https", Host: "sdd.example"},
		AdminGitHubIDs: map[int64]bool{7: true},
		SessionTTL:     30 * 24 * time.Hour,
		Version:        "test",
		Now:            func() time.Time { return e.now },
	})
	e.h = e.server.Handler()
	return e
}

func (e *authEnv) do(method, target string, cookies []*http.Cookie, header http.Header) *http.Response {
	e.t.Helper()
	req := httptest.NewRequest(method, "https://sdd.example"+target, nil)
	for k, v := range header {
		req.Header[k] = v
	}
	for _, c := range cookies {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return rec.Result()
}

func cookieNamed(res *http.Response, name string) *http.Cookie {
	for _, c := range res.Cookies() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

// signIn runs login → callback and returns the callback response.
func (e *authEnv) signIn(returnTo string) *http.Response {
	e.t.Helper()
	login := e.do("GET", "/api/auth/github/login?returnTo="+url.QueryEscape(returnTo), nil, nil)
	if login.StatusCode != http.StatusFound {
		e.t.Fatalf("login: status %d", login.StatusCode)
	}
	loc, _ := url.Parse(login.Header.Get("Location"))
	state := loc.Query().Get("state")
	oauth := cookieNamed(login, oauthCookieName)
	return e.do("GET", "/api/auth/github/callback?code=good&state="+state, []*http.Cookie{oauth}, nil)
}

func decode(t *testing.T, res *http.Response) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("status %d: body is not JSON", res.StatusCode)
	}
	return body
}

func TestLoginSetsStateCookieAndRedirects(t *testing.T) {
	e := newAuthEnv(t)
	res := e.do("GET", "/api/auth/github/login?returnTo=/topics/x", nil, nil)
	if res.StatusCode != http.StatusFound || !strings.HasPrefix(res.Header.Get("Location"), "https://github.com/") {
		t.Fatalf("got %d → %s", res.StatusCode, res.Header.Get("Location"))
	}
	c := cookieNamed(res, oauthCookieName)
	if c == nil || !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteLaxMode || c.Path != oauthCookiePath || c.MaxAge != 600 {
		t.Fatalf("bad oauth cookie: %+v", c)
	}
	st, ok := decodeOAuthState(&c.Value)
	loc, _ := url.Parse(res.Header.Get("Location"))
	if !ok || st.ReturnTo != "/topics/x" || st.State != loc.Query().Get("state") {
		t.Fatalf("bad state: %+v", st)
	}
}

func TestLoginWithoutGitHubConfigured(t *testing.T) {
	e := newAuthEnv(t)
	e.server.GitHub = nil
	res := e.do("GET", "/api/auth/github/login", nil, nil)
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("got %d", res.StatusCode)
	}
}

func TestSafeReturnTo(t *testing.T) {
	cases := map[string]string{
		"/topics/a?view=doc#x": "/topics/a?view=doc#x",
		"/":                    "/",
		"":                     "/",
		"https://evil.com":     "/",
		"//evil.com":           "/",
		"/\\evil.com":          "/",
		"evil.com":             "/",
		"/a\nb":                "/",
		"/api/auth/logout":     "/",
		"/api":                 "/",
		"/apiary":              "/apiary",
	}
	for in, want := range cases {
		if got := safeReturnTo(&in); got != want {
			t.Errorf("safeReturnTo(%q) = %q, want %q", in, got, want)
		}
	}
	if safeReturnTo(nil) != "/" {
		t.Error("nil should be /")
	}
}

func TestSignInFlow(t *testing.T) {
	e := newAuthEnv(t)
	res := e.signIn("/topics/url-shortener")

	if res.StatusCode != http.StatusFound || res.Header.Get("Location") != "/topics/url-shortener" {
		t.Fatalf("callback: %d → %s", res.StatusCode, res.Header.Get("Location"))
	}
	if c := cookieNamed(res, oauthCookieName); c == nil || c.MaxAge >= 0 {
		t.Fatalf("oauth cookie not cleared: %+v", c)
	}
	sess := cookieNamed(res, sessionCookieName)
	if sess == nil || !sess.HttpOnly || !sess.Secure || sess.Path != "/" || sess.MaxAge != int((30*24*time.Hour).Seconds()) {
		t.Fatalf("bad session cookie: %+v", sess)
	}
	if e.gh.gotVerifier == "" {
		t.Fatal("PKCE verifier not passed to GitHub")
	}
	// Only the hash is stored.
	for k := range e.store.sessions {
		if k == sess.Value {
			t.Fatal("raw token stored")
		}
	}

	me := e.do("GET", "/api/me", []*http.Cookie{sess}, nil)
	body := decode(t, me)
	if me.StatusCode != 200 || body["handle"] != "octocat" || body["name"] != "Octo Cat" || body["role"] != "user" {
		t.Fatalf("me: %d %v", me.StatusCode, body)
	}

	profile := e.do("GET", "/api/users/OCTOCAT", nil, nil)
	if body := decode(t, profile); profile.StatusCode != 200 || body["handle"] != "octocat" {
		t.Fatalf("profile: %d %v", profile.StatusCode, body)
	}
}

func TestSignInPromotesAdminsByGitHubID(t *testing.T) {
	e := newAuthEnv(t)
	e.gh.user = github.User{ID: 7, Login: "boss"}
	sess := cookieNamed(e.signIn("/"), sessionCookieName)
	if body := decode(t, e.do("GET", "/api/me", []*http.Cookie{sess}, nil)); body["role"] != "admin" {
		t.Fatalf("got %v", body)
	}
}

func TestSignInHandleTakenByAnotherAccount(t *testing.T) {
	e := newAuthEnv(t)
	e.gh.user = github.User{ID: 1, Login: "octocat"}
	e.signIn("/")
	e.gh.user = github.User{ID: 2, Login: "OctoCat"}
	sess := cookieNamed(e.signIn("/"), sessionCookieName)
	if body := decode(t, e.do("GET", "/api/me", []*http.Cookie{sess}, nil)); body["handle"] != "OctoCat-2" {
		t.Fatalf("got %v", body)
	}
}

func TestCallbackFailures(t *testing.T) {
	e := newAuthEnv(t)
	login := e.do("GET", "/api/auth/github/login?returnTo=/topics/a", nil, nil)
	oauth := cookieNamed(login, oauthCookieName)
	loc, _ := url.Parse(login.Header.Get("Location"))
	state := loc.Query().Get("state")

	cases := []struct {
		name    string
		query   string
		cookies []*http.Cookie
		want    string
	}{
		{"user declined", "?error=access_denied&state=" + state, []*http.Cookie{oauth}, "/topics/a?signInError=denied"},
		{"wrong state", "?code=good&state=forged", []*http.Cookie{oauth}, "/topics/a?signInError=state"},
		{"no state cookie", "?code=good&state=" + state, nil, "/?signInError=state"},
		{"missing code", "?state=" + state, []*http.Cookie{oauth}, "/topics/a?signInError=state"},
		{"github rejects code", "?code=bad&state=" + state, []*http.Cookie{oauth}, "/topics/a?signInError=github"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := e.do("GET", "/api/auth/github/callback"+tc.query, tc.cookies, nil)
			if res.StatusCode != http.StatusFound || res.Header.Get("Location") != tc.want {
				t.Fatalf("got %d → %s, want %s", res.StatusCode, res.Header.Get("Location"), tc.want)
			}
			if cookieNamed(res, sessionCookieName) != nil {
				t.Fatal("session cookie set on failure")
			}
		})
	}
}

func TestMeSignedOut(t *testing.T) {
	e := newAuthEnv(t)
	if res := e.do("GET", "/api/me", nil, nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("got %d", res.StatusCode)
	}
	// An unknown token is treated as signed out, and the stale cookie is cleared.
	res := e.do("GET", "/api/me", []*http.Cookie{{Name: sessionCookieName, Value: "forged"}}, nil)
	if c := cookieNamed(res, sessionCookieName); res.StatusCode != http.StatusUnauthorized || c == nil || c.MaxAge >= 0 {
		t.Fatalf("got %d, cookie %+v", res.StatusCode, c)
	}
}

func TestSessionExpiresAndSlides(t *testing.T) {
	e := newAuthEnv(t)
	sess := cookieNamed(e.signIn("/"), sessionCookieName)

	// Early in the session: no extension, no cookie re-sent.
	e.now = e.now.Add(24 * time.Hour)
	if res := e.do("GET", "/api/me", []*http.Cookie{sess}, nil); res.StatusCode != 200 || cookieNamed(res, sessionCookieName) != nil {
		t.Fatalf("day 1: %d", res.StatusCode)
	}

	// Past the halfway mark: extended to a full TTL from now, cookie re-sent.
	e.now = e.now.Add(20 * 24 * time.Hour)
	res := e.do("GET", "/api/me", []*http.Cookie{sess}, nil)
	if c := cookieNamed(res, sessionCookieName); res.StatusCode != 200 || c == nil || c.Value != sess.Value {
		t.Fatalf("day 21: %d, cookie %+v", res.StatusCode, c)
	}

	// Still valid 29 days after the extension, gone after 31.
	e.now = e.now.Add(29 * 24 * time.Hour)
	if res := e.do("GET", "/api/me", []*http.Cookie{sess}, nil); res.StatusCode != 200 {
		t.Fatalf("29 days after extension: %d", res.StatusCode)
	}
	e.now = e.now.Add(31 * 24 * time.Hour)
	if res := e.do("GET", "/api/me", []*http.Cookie{sess}, nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("after expiry: %d", res.StatusCode)
	}
}

func TestSessionLookupOutageIs503(t *testing.T) {
	e := newAuthEnv(t)
	sess := cookieNamed(e.signIn("/"), sessionCookieName)
	e.store.failSessions = true
	if res := e.do("GET", "/api/me", []*http.Cookie{sess}, nil); res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("got %d", res.StatusCode)
	}
}

func TestLogout(t *testing.T) {
	e := newAuthEnv(t)
	sess := cookieNamed(e.signIn("/"), sessionCookieName)

	res := e.do("POST", "/api/auth/logout", []*http.Cookie{sess}, http.Header{"Sec-Fetch-Site": {"same-origin"}})
	if c := cookieNamed(res, sessionCookieName); res.StatusCode != http.StatusNoContent || c == nil || c.MaxAge >= 0 {
		t.Fatalf("logout: %d, cookie %+v", res.StatusCode, c)
	}
	if len(e.store.sessions) != 0 {
		t.Fatal("session not deleted")
	}
	if res := e.do("GET", "/api/me", []*http.Cookie{sess}, nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("me after logout: %d", res.StatusCode)
	}
}

func TestCrossOriginMutationsAreRejected(t *testing.T) {
	e := newAuthEnv(t)
	sess := cookieNamed(e.signIn("/"), sessionCookieName)

	cases := []struct {
		name   string
		header http.Header
		want   int
	}{
		{"cross-site fetch", http.Header{"Sec-Fetch-Site": {"cross-site"}}, http.StatusForbidden},
		{"same-site, other origin", http.Header{"Sec-Fetch-Site": {"same-site"}}, http.StatusForbidden},
		{"foreign Origin, old browser", http.Header{"Origin": {"https://evil.example"}}, http.StatusForbidden},
		{"our public origin via proxy", http.Header{"Origin": {"https://sdd.example"}}, http.StatusNoContent},
		{"non-browser client", nil, http.StatusNoContent},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if res := e.do("POST", "/api/auth/logout", []*http.Cookie{sess}, tc.header); res.StatusCode != tc.want {
				t.Fatalf("got %d, want %d", res.StatusCode, tc.want)
			}
		})
	}
}

func TestGetUserNotFound(t *testing.T) {
	e := newAuthEnv(t)
	res := e.do("GET", "/api/users/nobody", nil, nil)
	if body := decode(t, res); res.StatusCode != http.StatusNotFound || body["message"] != "user not found" {
		t.Fatalf("got %d %v", res.StatusCode, body)
	}
}
