// migrations.go — locate the CREATE TABLE statement that defines a table.
//
// The digest maps a table to its creating migration by FILENAME only
// (`nodes ← 001_init.sql`), so a table node could point at the file and no
// further. That is enough to open the migration and not enough to say which of
// its statements is the one being talked about — 001_init.sql alone defines
// five of the tables merkle's routes touch. Consumers that want a position
// (the wire diagram's jump-to-definition, a symbol-granular curriculum) need
// the line.
//
// Cheap to do: migration DDL is plain text, one CREATE TABLE per table, and
// each file is read at most once.
package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// createTableRe matches the statement that defines a table, tolerating the
// spellings Postgres migrations actually use: IF NOT EXISTS, a schema
// qualifier, and quoted identifiers.
var createTableRe = regexp.MustCompile(`(?i)^\s*CREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."]+)`)

// tableName normalises `public."my_table"` to `my_table` for comparison.
func tableName(raw string) string {
	raw = strings.ReplaceAll(raw, `"`, "")
	if i := strings.LastIndex(raw, "."); i >= 0 {
		raw = raw[i+1:]
	}
	return strings.ToLower(raw)
}

// tableLine returns the 1-based line of `CREATE TABLE <table>` inside the
// backend-relative migration `rel`, or 0 when the file is unreadable or the
// statement is not there (a table created by ALTER, by a later rename, or in a
// migration the digest attributed differently). Zero is a legitimate answer and
// is reported as such: Node.Line is omitempty.
func (a *analyzer) tableLine(rel, table string) int {
	if a.migLines == nil {
		a.migLines = map[string]map[string]int{}
	}
	index, ok := a.migLines[rel]
	if !ok {
		index = map[string]int{}
		if raw, err := os.ReadFile(filepath.Join(a.backendDir, filepath.FromSlash(rel))); err == nil {
			for i, line := range strings.Split(string(raw), "\n") {
				if m := createTableRe.FindStringSubmatch(line); m != nil {
					if name := tableName(m[1]); index[name] == 0 {
						index[name] = i + 1
					}
				}
			}
		}
		a.migLines[rel] = index
	}
	return index[strings.ToLower(table)]
}
