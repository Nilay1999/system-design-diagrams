package httpapi

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Nilay1999/system-design-diagrams/server/internal/github"
	"github.com/Nilay1999/system-design-diagrams/server/internal/store"
)

// fakeStore is an in-memory Store that mimics the SQL's semantics (unique handles,
// expiry filtering) closely enough for handler tests. The real queries are tested
// against Postgres in store_test.go.
type fakeStore struct {
	mu       sync.Mutex
	users    map[int64]store.User // by id
	sessions map[string]store.Session
	nextID   int64
	now      func() time.Time
	// failSessions makes GetSessionUser fail, as during a database outage.
	failSessions bool
}

func newFakeStore() *fakeStore {
	return &fakeStore{users: map[int64]store.User{}, sessions: map[string]store.Session{}, now: time.Now}
}

func (f *fakeStore) UpsertGitHubUser(_ context.Context, p store.UpsertGitHubUserParams) (store.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var existing *store.User
	for _, u := range f.users {
		if u.GithubID == p.GithubID {
			existing = &u
		} else if strings.EqualFold(u.Handle, p.Handle) {
			return store.User{}, &pgconn.PgError{Code: "23505", ConstraintName: "users_handle_key"}
		}
	}
	if existing == nil {
		f.nextID++
		existing = &store.User{ID: f.nextID, GithubID: p.GithubID, Role: "user", CreatedAt: f.now()}
	}
	existing.Handle, existing.Name, existing.AvatarUrl = p.Handle, p.Name, p.AvatarUrl
	if p.PromoteAdmin {
		existing.Role = "admin"
	}
	f.users[existing.ID] = *existing
	return *existing, nil
}

func (f *fakeStore) GetUserByHandle(_ context.Context, handle string) (store.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, u := range f.users {
		if strings.EqualFold(u.Handle, handle) {
			return u, nil
		}
	}
	return store.User{}, pgx.ErrNoRows
}

func (f *fakeStore) CreateSession(_ context.Context, p store.CreateSessionParams) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sessions[string(p.IDHash)] = store.Session{IDHash: p.IDHash, UserID: p.UserID, ExpiresAt: p.ExpiresAt, UserAgent: p.UserAgent}
	return nil
}

func (f *fakeStore) GetSessionUser(_ context.Context, hash []byte) (store.GetSessionUserRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failSessions {
		return store.GetSessionUserRow{}, errors.New("connection refused")
	}
	s, ok := f.sessions[string(hash)]
	if !ok || !s.ExpiresAt.After(f.now()) {
		return store.GetSessionUserRow{}, pgx.ErrNoRows
	}
	return store.GetSessionUserRow{User: f.users[s.UserID], ExpiresAt: s.ExpiresAt}, nil
}

func (f *fakeStore) ExtendSession(_ context.Context, p store.ExtendSessionParams) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.sessions[string(p.IDHash)]
	s.ExpiresAt = p.ExpiresAt
	f.sessions[string(p.IDHash)] = s
	return nil
}

func (f *fakeStore) DeleteSession(_ context.Context, hash []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.sessions, string(hash))
	return nil
}

func (f *fakeStore) DeleteExpiredSessions(_ context.Context, userID int64) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var n int64
	for k, s := range f.sessions {
		if s.UserID == userID && !s.ExpiresAt.After(f.now()) {
			delete(f.sessions, k)
			n++
		}
	}
	return n, nil
}

// fakeGitHub accepts code "good" and returns user.
type fakeGitHub struct {
	user        github.User
	gotVerifier string
}

func (g *fakeGitHub) AuthCodeURL(state, _ string) string {
	return "https://github.com/login/oauth/authorize?state=" + state
}

func (g *fakeGitHub) FetchUser(_ context.Context, code, verifier string) (github.User, error) {
	g.gotVerifier = verifier
	if code != "good" {
		return github.User{}, errors.New("bad_verification_code")
	}
	return g.user, nil
}
