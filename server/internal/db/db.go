// Package db opens the Postgres pool and runs schema migrations.
package db

import (
	"context"
	"database/sql"
	"embed"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

//go:embed migrations/*.sql
var migrations embed.FS

// Connect opens a pool and checks the database is reachable.
func Connect(ctx context.Context, url string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connect to postgres: %w", err)
	}
	return pool, nil
}

// Migrate runs a goose command ("up", "down", "status", "redo", "reset", …) against the
// embedded migrations.
func Migrate(ctx context.Context, pool *pgxpool.Pool, command string, args ...string) error {
	conn := stdlib.OpenDBFromPool(pool)
	defer func() { _ = conn.Close() }()
	return migrate(ctx, conn, command, args...)
}

func migrate(ctx context.Context, conn *sql.DB, command string, args ...string) error {
	goose.SetBaseFS(migrations)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	return goose.RunContext(ctx, command, conn, "migrations", args...)
}
