package github

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"golang.org/x/oauth2"
)

func fakeGitHub(t *testing.T, userStatus int, userBody string) *Client {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /login/oauth/access_token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("code") != "the-code" || r.Form.Get("code_verifier") != "the-verifier" {
			http.Error(w, "bad code or verifier", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"access_token": "tok", "token_type": "bearer"})
	})
	mux.HandleFunc("GET /user", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.WriteHeader(userStatus)
		_, _ = w.Write([]byte(userBody))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return New("id", "secret", "http://app/cb", &Options{
		Endpoint: oauth2.Endpoint{
			AuthURL:   srv.URL + "/login/oauth/authorize",
			TokenURL:  srv.URL + "/login/oauth/access_token",
			AuthStyle: oauth2.AuthStyleInParams,
		},
		APIBase: srv.URL,
	})
}

func TestAuthCodeURL(t *testing.T) {
	c := New("client-id", "secret", "https://app.example/api/auth/github/callback", nil)
	u, err := url.Parse(c.AuthCodeURL("st", "verifier"))
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if u.Host != "github.com" || q.Get("client_id") != "client-id" || q.Get("state") != "st" ||
		q.Get("scope") != "read:user" || q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" ||
		q.Get("redirect_uri") != "https://app.example/api/auth/github/callback" {
		t.Fatalf("unexpected auth URL: %s", u)
	}
}

func TestFetchUser(t *testing.T) {
	c := fakeGitHub(t, 200, `{"id": 42, "login": "octocat", "name": "The Octocat", "avatar_url": "https://a/1"}`)
	u, err := c.FetchUser(context.Background(), "the-code", "the-verifier")
	if err != nil {
		t.Fatal(err)
	}
	if u != (User{ID: 42, Login: "octocat", Name: "The Octocat", AvatarURL: "https://a/1"}) {
		t.Fatalf("got %+v", u)
	}
}

func TestFetchUserNullName(t *testing.T) {
	c := fakeGitHub(t, 200, `{"id": 42, "login": "octocat", "name": null, "avatar_url": ""}`)
	u, err := c.FetchUser(context.Background(), "the-code", "the-verifier")
	if err != nil || u.Name != "" {
		t.Fatalf("got %+v, %v", u, err)
	}
}

func TestFetchUserErrors(t *testing.T) {
	cases := []struct {
		name, code, body string
		status           int
		want             string
	}{
		{"bad code", "wrong", `{}`, 200, "exchange code"},
		{"user endpoint fails", "the-code", `{}`, 500, "status 500"},
		{"missing id", "the-code", `{"login": "x"}`, 200, "no id or login"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := fakeGitHub(t, tc.status, tc.body)
			_, err := c.FetchUser(context.Background(), tc.code, "the-verifier")
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want error containing %q", err, tc.want)
			}
		})
	}
}
