package driver

import "strings"

// IsSystemDatabase reports whether a database belongs to the server rather
// than the user. These are hidden unless "show system objects" is enabled:
// on a typical server they outnumber the user's own databases and bury them
// in both the sidebar and the command palette.
func IsSystemDatabase(k Kind, name string) bool {
	n := strings.ToLower(name)
	switch k {
	case KindMySQL:
		switch n {
		case "information_schema", "mysql", "performance_schema", "sys":
			return true
		}
	case KindPostgres:
		// template0/template1 are already excluded by the catalogue query;
		// "postgres" is the maintenance database, which ja-db connects to as
		// a bootstrap but which almost never holds anything of interest.
		switch n {
		case "postgres", "template0", "template1":
			return true
		}
	case KindMSSQL:
		switch n {
		case "master", "model", "msdb", "tempdb":
			return true
		}
	}
	return false
}

// IsSystemSchema reports whether a schema belongs to the server. The
// per-dialect catalogue queries already exclude the worst offenders; this
// covers what they cannot express cheaply.
func IsSystemSchema(k Kind, schema string) bool {
	s := strings.ToLower(schema)
	switch k {
	case KindPostgres:
		return s == "pg_catalog" || s == "information_schema" ||
			strings.HasPrefix(s, "pg_toast") || strings.HasPrefix(s, "pg_temp")
	case KindMSSQL:
		return s == "sys" || s == "information_schema"
	}
	return false
}
