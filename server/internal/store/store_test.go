package store_test

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Nilay1999/system-design-diagrams/server/internal/db"
	"github.com/Nilay1999/system-design-diagrams/server/internal/store"
)

// Runs against TEST_DATABASE_URL, which is reset. See internal/db/db_test.go.
func setup(t *testing.T) (*store.Queries, context.Context) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := db.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	for _, cmd := range []string{"reset", "up"} {
		if err := db.Migrate(ctx, pool, cmd); err != nil {
			t.Fatalf("migrate %s: %v", cmd, err)
		}
	}
	return store.New(pool), ctx
}

func TestUpsertGitHubUser(t *testing.T) {
	q, ctx := setup(t)

	u, err := q.UpsertGitHubUser(ctx, store.UpsertGitHubUserParams{GithubID: 1, Handle: "Octocat", Name: "Octo"})
	if err != nil {
		t.Fatal(err)
	}
	if u.Role != "user" || u.Reputation != 0 || u.CreatedAt.IsZero() {
		t.Fatalf("new user: %+v", u)
	}

	// Signing in again refreshes the profile and keeps the id.
	u2, err := q.UpsertGitHubUser(ctx, store.UpsertGitHubUserParams{GithubID: 1, Handle: "octocat-renamed", Name: "Octo 2"})
	if err != nil || u2.ID != u.ID || u2.Handle != "octocat-renamed" || u2.Name != "Octo 2" {
		t.Fatalf("re-sign-in: %+v %v", u2, err)
	}

	// Handles are unique case-insensitively.
	_, err = q.UpsertGitHubUser(ctx, store.UpsertGitHubUserParams{GithubID: 2, Handle: "OCTOCAT-RENAMED"})
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" || pgErr.ConstraintName != "users_handle_key" {
		t.Fatalf("expected handle conflict, got %v", err)
	}

	got, err := q.GetUserByHandle(ctx, "OctoCat-Renamed")
	if err != nil || got.ID != u.ID {
		t.Fatalf("lookup by handle: %+v %v", got, err)
	}
	if _, err := q.GetUserByHandle(ctx, "nobody"); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("expected ErrNoRows, got %v", err)
	}
}

func TestPromoteAdminNeverDemotes(t *testing.T) {
	q, ctx := setup(t)
	u, _ := q.UpsertGitHubUser(ctx, store.UpsertGitHubUserParams{GithubID: 1, Handle: "a", PromoteAdmin: true})
	if u.Role != "admin" {
		t.Fatalf("not promoted: %s", u.Role)
	}
	u, _ = q.UpsertGitHubUser(ctx, store.UpsertGitHubUserParams{GithubID: 1, Handle: "a", PromoteAdmin: false})
	if u.Role != "admin" {
		t.Fatalf("demoted: %s", u.Role)
	}
}

func TestSessions(t *testing.T) {
	q, ctx := setup(t)
	u, _ := q.UpsertGitHubUser(ctx, store.UpsertGitHubUserParams{GithubID: 1, Handle: "a"})
	now := time.Now()

	live, expired := []byte("live-hash"), []byte("expired-hash")
	for _, s := range []store.CreateSessionParams{
		{IDHash: live, UserID: u.ID, ExpiresAt: now.Add(time.Hour), UserAgent: "test"},
		{IDHash: expired, UserID: u.ID, ExpiresAt: now.Add(-time.Minute)},
	} {
		if err := q.CreateSession(ctx, s); err != nil {
			t.Fatal(err)
		}
	}

	row, err := q.GetSessionUser(ctx, live)
	if err != nil || row.User.ID != u.ID || row.User.Handle != "a" {
		t.Fatalf("live session: %+v %v", row, err)
	}
	if _, err := q.GetSessionUser(ctx, expired); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("expired session should not resolve, got %v", err)
	}

	later := now.Add(48 * time.Hour).Truncate(time.Microsecond)
	if err := q.ExtendSession(ctx, store.ExtendSessionParams{IDHash: live, ExpiresAt: later}); err != nil {
		t.Fatal(err)
	}
	if row, _ := q.GetSessionUser(ctx, live); !row.ExpiresAt.Equal(later) {
		t.Fatalf("not extended: %v", row.ExpiresAt)
	}

	if n, err := q.DeleteExpiredSessions(ctx, u.ID); err != nil || n != 1 {
		t.Fatalf("delete expired: %d %v", n, err)
	}
	if err := q.DeleteSession(ctx, live); err != nil {
		t.Fatal(err)
	}
	if _, err := q.GetSessionUser(ctx, live); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("deleted session still resolves: %v", err)
	}
}
