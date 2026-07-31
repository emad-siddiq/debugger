package main

import (
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite golden files")

// TestFixtureFlows runs the full pipeline over the stdlib-only fixture app and
// compares against the golden flows document. Regenerate with `go test -update`.
func TestFixtureFlows(t *testing.T) {
	dir, err := filepath.Abs("testdata/fixtureapp")
	if err != nil {
		t.Fatal(err)
	}
	a, err := newAnalyzer(dir, nil)
	if err != nil {
		t.Fatalf("newAnalyzer: %v", err)
	}
	terminals := discoverTerminals(a)
	doc := assemble(a, terminals, nil, "")

	got, err := json.MarshalIndent(doc, "", " ")
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')

	golden := "testdata/golden_flows.json"
	if *update {
		if err := os.WriteFile(golden, got, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s", golden)
		return
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatalf("read golden (run `go test -update` once): %v", err)
	}
	if string(got) != string(want) {
		t.Errorf("flows drifted from golden.\n--- got ---\n%s", got)
	}
}

// TestStdlibFixtureFlows — the same pipeline over a fixture that uses only
// net/http, in the shapes a service written since Go 1.22 uses.
//
// Its own golden, and its own fixture, because the point is a router library
// rather than a repository: flowscan seeded on `NewRouter()`/`NewMux()`, so a
// project using `http.NewServeMux` traced ZERO — true of Burrow's own scaffold
// and of prometheus/alertmanager, neither of which is unusual.
//
// Regenerate with `go test -update`.
func TestStdlibFixtureFlows(t *testing.T) {
	dir, err := filepath.Abs("testdata/stdlibapp")
	if err != nil {
		t.Fatal(err)
	}
	a, err := newAnalyzer(dir, nil)
	if err != nil {
		t.Fatalf("newAnalyzer: %v", err)
	}
	doc := assemble(a, discoverTerminals(a), nil, "")

	// The claims worth asserting by hand, so a careless golden refresh cannot
	// quietly restore the old behaviour.
	byPath := map[string]*Flow{}
	for _, f := range doc.Flows {
		byPath[f.Method+" "+f.Path] = f
	}
	for _, want := range []string{
		"GET /healthz",             // method split out of the pattern
		"DELETE /api/widgets/{id}", // …with a wildcard after it
		"GET /assets/{path...}",    // multi-segment wildcard, left as written
		"GET /exact/{$}",           // exact-match marker, left as written
		"* /legacy",                // no method in the pattern is legal
		"* /debug/",                // subtree: the trailing slash is semantic
		"POST /admin/reload",       // registered by a func that receives the mux
		"GET /ping",                // http.HandleFunc — the DEFAULT mux
		"POST /api/events",         // …and it reaches the SQL
		"* /static/",               // http.Handle on the default mux
	} {
		if byPath[want] == nil {
			t.Errorf("missing route %q", want)
		}
	}
	// A route whose method is still glued to the path is the exact regression
	// this work order fixes.
	for _, f := range doc.Flows {
		if strings.ContainsAny(f.Path, " \t") {
			t.Errorf("route %q %q has whitespace in its path — the method was not split out", f.Method, f.Path)
		}
	}
	// The handler is a composed expression, so it cannot be followed. The route
	// still has to be LISTED, with a reason.
	if f := byPath["* /debug/"]; f != nil {
		if f.Status != "unknown" {
			t.Errorf("/debug/ status = %q, want unknown — an unfollowable handler is not a partial trace", f.Status)
		}
		if len(f.Nodes) == 0 || f.Nodes[0].Reason == "" {
			t.Error("/debug/ must say WHY the handler did not resolve")
		}
	}

	got, err := json.MarshalIndent(doc, "", " ")
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')

	golden := "testdata/golden_stdlib_flows.json"
	if *update {
		if err := os.WriteFile(golden, got, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s", golden)
		return
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatalf("read golden (run `go test -update` once): %v", err)
	}
	if string(got) != string(want) {
		t.Errorf("stdlib flows drifted from golden.\n--- got ---\n%s", got)
	}
}

func TestSQLKind(t *testing.T) {
	cases := map[string]string{
		"SELECT * FROM nodes":                                    "read",
		"  select 1":                                             "read",
		"INSERT INTO nodes (id) VALUES ($1)":                     "write",
		"UPDATE nodes SET name=$1":                               "write",
		"DELETE FROM nodes WHERE id=$1":                          "write",
		"WITH x AS (SELECT 1) SELECT * FROM x":                   "read",
		"WITH d AS (DELETE FROM a RETURNING id) SELECT * FROM d": "write",
		"TRUNCATE nodes":                                         "write",
	}
	for sql, want := range cases {
		if got := sqlKind(sql); got != want {
			t.Errorf("sqlKind(%q) = %q, want %q", sql, got, want)
		}
	}
}

func TestExtractTables(t *testing.T) {
	known := map[string]string{"nodes": "001.sql", "node_field_definitions": "002.sql", "orgs": "003.sql"}
	cases := []struct {
		sql  string
		want []string
	}{
		{"SELECT * FROM nodes WHERE org_id=$1", []string{"nodes"}},
		{"SELECT a FROM nodes n JOIN orgs o ON o.id=n.org_id", []string{"nodes", "orgs"}},
		{"SELECT x FROM node_field_definitions WHERE node_id IN (SELECT id FROM nodes)", []string{"node_field_definitions", "nodes"}},
		{"WITH recent AS (SELECT * FROM nodes) SELECT * FROM recent", []string{"nodes"}},
		{"SELECT * FROM unnest($1::text[])", nil},
		{"SELECT * FROM not_a_known_table", nil},
	}
	for _, c := range cases {
		got := extractTables(c.sql, known)
		if len(got) != len(c.want) {
			t.Errorf("extractTables(%q) = %v, want %v", c.sql, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("extractTables(%q) = %v, want %v", c.sql, got, c.want)
				break
			}
		}
	}
}

func TestJoinPath(t *testing.T) {
	cases := []struct{ prefix, p, want string }{
		{"", "/healthz", "/healthz"},
		{"/api", "/nodes", "/api/nodes"},
		{"/api", "/", "/api"},
		{"", "/", "/"},
		{"/api/v1", "/sub/things", "/api/v1/sub/things"},
	}
	for _, c := range cases {
		if got := joinPath(c.prefix, c.p); got != c.want {
			t.Errorf("joinPath(%q,%q) = %q, want %q", c.prefix, c.p, got, c.want)
		}
	}
}
