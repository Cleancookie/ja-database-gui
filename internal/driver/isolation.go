package driver

import (
	"database/sql"
	"fmt"
)

// isolationNames is the only way an isolation level reaches the server. The
// editor sends a name; it is looked up here and then checked against the
// dialect's own list, and the result is a Go constant handed to BeginTx. The
// name itself is never put in SQL.
var isolationNames = map[string]sql.IsolationLevel{
	"read uncommitted": sql.LevelReadUncommitted,
	"read committed":   sql.LevelReadCommitted,
	"repeatable read":  sql.LevelRepeatableRead,
	"serializable":     sql.LevelSerializable,
	"snapshot":         sql.LevelSnapshot,
}

// IsolationFor resolves a level name chosen in the editor. "" means the driver
// default, which is sql.LevelDefault and tells the caller not to open a
// transaction. Anything not in the dialect's allow-list is an error.
func IsolationFor(caps Capabilities, name string) (sql.IsolationLevel, error) {
	if name == "" {
		return sql.LevelDefault, nil
	}
	level, known := isolationNames[name]
	if known {
		for _, allowed := range caps.IsolationLevels {
			if allowed == name {
				return level, nil
			}
		}
	}
	return sql.LevelDefault, fmt.Errorf("%s does not support isolation level %q", caps.DisplayName, name)
}
