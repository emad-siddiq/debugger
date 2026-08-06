// sql.go — classify SQL statements and extract the tables they touch.
package main

import (
	"regexp"
	"sort"
	"strings"
)

// tableRefRe matches identifiers in table position. Quoted identifiers and
// schema-qualified names are rare in nodewatch-shaped SQL; plain idents cover it.
// The KEYWORD is captured too: it is what says whether the statement reads the
// table or writes it, and it was being matched and thrown away.
var tableRefRe = regexp.MustCompile(`(?is)\b(from|join|insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+([a-z_][a-z0-9_]*)`)

// nonTables are idents that appear in table position but are not tables.
var nonTables = map[string]bool{
	"select": true, "unnest": true, "generate_series": true, "jsonb_each": true,
	"jsonb_array_elements": true, "lateral": true, "only": true, "values": true,
}

// tableRef is one table the statement touches, and what it does to it.
type tableRef struct {
	Name  string
	Write bool
}

// tableRefs returns the distinct tables sql references, sorted by name, each
// marked read or write by the keyword that introduced it. FROM and JOIN read;
// INSERT INTO, UPDATE, DELETE FROM and TRUNCATE write. A table in both
// positions in one statement (`UPDATE x … FROM x`) counts as a write — the
// stronger claim is the one worth showing.
//
// When known is non-empty, only names present in it are kept (CTE names and
// set-returning functions drop out for free).
func tableRefs(sql string, known map[string]string) []tableRef {
	cteNames := cteNamesIn(sql)
	writes := map[string]bool{}
	for _, m := range tableRefRe.FindAllStringSubmatch(sql, -1) {
		name := strings.ToLower(m[2])
		if nonTables[name] || cteNames[name] {
			continue
		}
		if len(known) > 0 {
			if _, ok := known[name]; !ok {
				continue
			}
		}
		switch strings.ToLower(firstWord(strings.TrimSpace(m[1]))) {
		case "from", "join":
			// A read never downgrades a write recorded elsewhere in the same
			// statement, so only set when absent.
			if _, seen := writes[name]; !seen {
				writes[name] = false
			}
		default:
			writes[name] = true
		}
	}
	out := make([]tableRef, 0, len(writes))
	for name, write := range writes {
		out = append(out, tableRef{Name: name, Write: write})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// extractTables returns the distinct table names referenced by sql, sorted.
func extractTables(sql string, known map[string]string) []string {
	refs := tableRefs(sql, known)
	out := make([]string, 0, len(refs))
	for _, ref := range refs {
		out = append(out, ref.Name)
	}
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
