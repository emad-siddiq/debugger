// sql.go — classify SQL statements and extract the tables they touch.
package main

import (
	"regexp"
	"sort"
	"strings"
)

// tableRefRe matches identifiers in table position. Quoted identifiers and
// schema-qualified names are rare in nodewatch-shaped SQL; plain idents cover it.
var tableRefRe = regexp.MustCompile(`(?is)\b(?:from|join|insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+([a-z_][a-z0-9_]*)`)

// nonTables are idents that appear in table position but are not tables.
var nonTables = map[string]bool{
	"select": true, "unnest": true, "generate_series": true, "jsonb_each": true,
	"jsonb_array_elements": true, "lateral": true, "only": true, "values": true,
}

// extractTables returns the distinct table names referenced by sql, sorted.
// When known is non-empty, only names present in it are kept (CTE names and
// set-returning functions drop out for free).
func extractTables(sql string, known map[string]string) []string {
	cteNames := cteNamesIn(sql)
	seen := map[string]bool{}
	for _, m := range tableRefRe.FindAllStringSubmatch(sql, -1) {
		name := strings.ToLower(m[1])
		if nonTables[name] || cteNames[name] {
			continue
		}
		if len(known) > 0 {
			if _, ok := known[name]; !ok {
				continue
			}
		}
		seen[name] = true
	}
	out := make([]string, 0, len(seen))
	for name := range seen {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

var cteRe = regexp.MustCompile(`(?is)(?:\bwith\b|,)\s*([a-z_][a-z0-9_]*)\s*(?:\([^)]*\))?\s+as\s*\(`)

func cteNamesIn(sql string) map[string]bool {
	names := map[string]bool{}
	for _, m := range cteRe.FindAllStringSubmatch(sql, -1) {
		names[strings.ToLower(m[1])] = true
	}
	return names
}

var writeRe = regexp.MustCompile(`(?is)\b(insert|update|delete|truncate|alter|create|drop|copy)\b`)

// sqlKind reports read or write. A WITH … statement is a write if any DML
// keyword appears anywhere in it (data-modifying CTEs).
func sqlKind(sql string) string {
	trimmed := strings.TrimSpace(sql)
	switch strings.ToLower(firstWord(trimmed)) {
	case "select", "show", "explain", "table":
		return "read"
	case "with":
		if writeRe.MatchString(trimmed) {
			return "write"
		}
		return "read"
	case "insert", "update", "delete", "truncate", "merge", "copy":
		return "write"
	default:
		if writeRe.MatchString(trimmed) {
			return "write"
		}
		return "read"
	}
}

func firstWord(s string) string {
	for i, r := range s {
		if r == ' ' || r == '\n' || r == '\t' || r == '\r' || r == '(' {
			return s[:i]
		}
	}
	return s
}

// squishSQL collapses whitespace runs so flows.json stays compact and the
// diagram tooltip renders on a few lines.
var wsRe = regexp.MustCompile(`\s+`)

func squishSQL(sql string) string {
	return strings.TrimSpace(wsRe.ReplaceAllString(sql, " "))
}
