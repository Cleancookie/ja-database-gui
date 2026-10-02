package driver

import (
	"context"
	"database/sql"
)

// Cancelling a context is what stops a query, and what that does on the server
// differs by driver (verified against the versions in go.mod):
//
//   - SQLite: modernc interrupts the statement. Enough.
//   - SQL Server: go-mssqldb sends a TDS attention packet, which the server
//     answers by aborting the batch. Enough, and KILL would need ALTER ANY
//     CONNECTION and drop the whole session, so it is not used.
//   - PostgreSQL: pgx expires the socket deadline, closes the connection and, on
//     a second socket, sends a cancel request. Best effort and asynchronous, so
//     pg_cancel_backend is sent too.
//   - MySQL / MariaDB: go-sql-driver only closes the socket. The server carries
//     on with the statement until it next writes to the client. KILL QUERY on a
//     second connection is the only thing that stops it.
//
// Where a kill is needed the query's session id is captured on a pinned
// connection before the statement starts, and the kill goes out on another
// connection from the same pool, under a short timeout (activity.killTimeout);
// if the pool is exhausted the context cancel that follows is the fallback. Only ids captured here are ever killed.

// CaptureSessionID asks the server which session conn is. ok is false for a
// dialect that does not need one, or when the server would not say.
func CaptureSessionID(ctx context.Context, d Driver, conn *sql.Conn) (id int64, ok bool) {
	q := d.SessionIDQuery()
	if q == "" {
		return 0, false
	}
	if err := conn.QueryRowContext(ctx, q).Scan(&id); err != nil {
		return 0, false
	}
	return id, true
}

// KillFunc returns the function that stops session id by borrowing another
// connection from db. The statement is built from an int64, never from text.
func KillFunc(d Driver, db *sql.DB, id int64) func(context.Context) error {
	return func(ctx context.Context) error {
		conn, err := db.Conn(ctx)
		if err != nil {
			return err
		}
		defer conn.Close()
		_, err = conn.ExecContext(ctx, d.KillStatement(id))
		return err
	}
}
