// Package github implements the GitHub side of "Sign in with GitHub": the OAuth
// authorization-code flow (with PKCE) and reading the signed-in user's profile.
package github

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/endpoints"
)

// User is the part of GitHub's /user response the app keeps.
type User struct {
	ID        int64
	Login     string
	Name      string
	AvatarURL string
}

// Client talks to github.com. The zero value isn't usable; call New.
type Client struct {
	oauth   *oauth2.Config
	apiBase string
	http    *http.Client
}

// Options overrides GitHub's URLs, for tests.
type Options struct {
	Endpoint oauth2.Endpoint
	APIBase  string
}

// New returns a client for an OAuth app. redirectURL must match the app's callback URL.
func New(clientID, clientSecret, redirectURL string, opts *Options) *Client {
	c := &Client{
		oauth: &oauth2.Config{
			ClientID:     clientID,
			ClientSecret: clientSecret,
			RedirectURL:  redirectURL,
			Endpoint:     endpoints.GitHub,
			// The public profile is all sign-in needs: no email, no repo access.
			Scopes: []string{"read:user"},
		},
		apiBase: "https://api.github.com",
		http:    &http.Client{Timeout: 10 * time.Second},
	}
	if opts != nil {
		c.oauth.Endpoint = opts.Endpoint
		c.apiBase = opts.APIBase
	}
	return c
}

// AuthCodeURL is GitHub's consent page for this sign-in attempt.
func (c *Client) AuthCodeURL(state, verifier string) string {
	return c.oauth.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier))
}

// FetchUser exchanges the callback's code for a token and returns who signed in. The
// token is used once and thrown away; the app never calls GitHub on the user's behalf.
func (c *Client) FetchUser(ctx context.Context, code, verifier string) (User, error) {
	ctx = context.WithValue(ctx, oauth2.HTTPClient, c.http)
	tok, err := c.oauth.Exchange(ctx, code, oauth2.VerifierOption(verifier))
	if err != nil {
		return User{}, fmt.Errorf("exchange code: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.apiBase+"/user", nil)
	if err != nil {
		return User{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	tok.SetAuthHeader(req)

	res, err := c.http.Do(req)
	if err != nil {
		return User{}, fmt.Errorf("get user: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return User{}, fmt.Errorf("get user: status %d", res.StatusCode)
	}

	var body struct {
		ID        int64   `json:"id"`
		Login     string  `json:"login"`
		Name      *string `json:"name"`
		AvatarURL string  `json:"avatar_url"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return User{}, fmt.Errorf("decode user: %w", err)
	}
	if body.ID == 0 || body.Login == "" {
		return User{}, fmt.Errorf("get user: response has no id or login")
	}
	u := User{ID: body.ID, Login: body.Login, AvatarURL: body.AvatarURL}
	if body.Name != nil {
		u.Name = *body.Name
	}
	return u, nil
}
