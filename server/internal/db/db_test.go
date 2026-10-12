package db

import (
	"context"
	"os"
	"testing"
)

// Runs against a real Postgres when TEST_DATABASE_URL is set (CI provides one; locally,
// `docker compose up -d postgres`). The database is reset, so never point it at real data.
func TestMigrationsRoundTrip(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	for _, cmd := range []string{"up", "reset", "up"} {
		if err := Migrate(ctx, pool, cmd); err != nil {
			t.Fatalf("migrate %s: %v", cmd, err)
		}
	}

	var n int
	err = pool.QueryRow(ctx, `SELECT count(*) FROM pg_extension WHERE extname IN ('citext', 'pg_trgm')`).Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("expected both extensions installed, got %d", n)
	}
}
