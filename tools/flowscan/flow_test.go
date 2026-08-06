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
	terminals, unfollowed := discoverRouters(a)
	doc := assembleWith(a, terminals, unfollowed, nil, "")

	// The BUILDER CHAIN shapes (WO-77 §1), asserted by hand so a careless golden
	// refresh cannot quietly restore the old behaviour.
	byKey := map[string]*Flow{}
	for _, f := range doc.Flows {
		byKey[f.Method+" "+f.Path] = f
	}
	// `NewRouter().WithInstrumentation(h)` — a constructor that is the RECEIVER of
	// a method call rather than the bare RHS of an assignment. Tracking only the
	// bare form is why alertmanager reported 2 routes and had 22.
	if byKey["GET /instrumented"] == nil {
		t.Error("a router built through a non-string builder step was not followed")
	}
	// `r = r.WithPrefix("/v2")` — the same chain shape with a STRING argument. The
	// routes stay (at their unprefixed paths) and the router is NOTED.
	if byKey["GET /after-prefix"] == nil {
		t.Error("routes after an opaque builder step were dropped; they should be kept and noted")
	}
	if len(doc.Coverage.Unfollowed) != 1 {
		t.Fatalf("want exactly one unfollowed router (the WithPrefix step), got %d", len(doc.Coverage.Unfollowed))
	}
	if u := doc.Coverage.Unfollowed[0]; !strings.Contains(u.Reason, "WithPrefix") {
		t.Errorf("the note must name the step it could not interpret, got %q", u.Reason)
	} else if strings.Contains(u.Reason, "left untraced") {
		t.Error("the note contradicts the behaviour: those routes ARE traced")
	}

	assertEdgeRelations(t, byKey)
	assertConditionalMiddleware(t, byKey)

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
	terminals, unfollowed := discoverRouters(a)
	doc := assembleWith(a, terminals, unfollowed, nil, "")

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
	// Every router here is followed, so nothing may be noted. A false note is the
	// failure mode this state exists to avoid — a signal that cries wolf gets
	// ignored exactly when it is right.
	if n := len(doc.Coverage.Unfollowed); n != 0 {
		t.Errorf("no router in this fixture is unfollowable, got %d note(s): %+v", n, doc.Coverage.Unfollowed)
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

// assertEdgeRelations pins what each curve in the wire diagram MEANS.
//
// An edge used to be two integers, so every curve in the diagram claimed the
// same unfalsifiable "this leads to that" and a reader had to open the code to
// find out which. These assertions are by hand, ahead of the golden compare, so
// a careless `go test -update` cannot quietly take the meaning away again.
func assertEdgeRelations(t *testing.T, byKey map[string]*Flow) {
	t.Helper()

	// Every edge says something. A blank verb is the old behaviour returning.
	for key, f := range byKey {
		for _, e := range f.Edges {
			if e.Rel == "" {
				t.Errorf("%s: edge %d→%d carries no relation", key, e.From, e.To)
			}
		}
	}

	// The store hop, which is the case that started this: the handler takes a
	// `gadgetStore` INTERFACE and the box shows `PgxGadgetStore.Fetch`, so
	// nothing in the handler names what the box names.
	f := byKey["GET /api/gadgets/{id}"]
	if f == nil {
		t.Fatal("GET /api/gadgets/{id} not traced")
	}
	call := edgeBetween(t, f, "handler", "store")
	if call.Rel != RelCalls {
		t.Errorf("handler→store rel = %q, want %q", call.Rel, RelCalls)
	}
	// The edge points at the CALL, the box at the DECLARATION. That difference
	// is the whole feature: the line the edge names is the line that joins them.
	if src := lineAt(t, call.File, call.Line); !strings.Contains(src, "s.Fetch(") {
		t.Errorf("handler→store edge points at %s:%d = %q, want the line calling s.Fetch",
			call.File, call.Line, strings.TrimSpace(src))
	}
	if store := nodeOfKind(f, "store"); store != nil && store.Line == call.Line {
		t.Error("the edge's line equals the store method's declaration — it must be the call site")
	}
	if exec := edgeBetween(t, f, "store", "query"); exec.Rel != RelExecutes {
		t.Errorf("store→query rel = %q, want %q", exec.Rel, RelExecutes)
	}
	for _, e := range edgesOfKind(f, "query", "table") {
		if e.Rel != RelReads {
			t.Errorf("SELECT…JOIN → %s rel = %q, want %q", f.Nodes[e.To].Label, e.Rel, RelReads)
		}
	}

	// A DELETE writes the table it names.
	if f := byKey["DELETE /api/widgets/{id}"]; f != nil {
		for _, e := range edgesOfKind(f, "query", "table") {
			if e.Rel != RelWrites {
				t.Errorf("DELETE → %s rel = %q, want %q", f.Nodes[e.To].Label, e.Rel, RelWrites)
			}
		}
	} else {
		t.Error("DELETE /api/widgets/{id} not traced")
	}

	// One statement, two tables, two different verbs. Node.SQLKind is a single
	// verdict for the whole statement and cannot express this, which is why the
	// table edges are classified one at a time.
	if f := byKey["POST /api/gadgets/audit"]; f != nil {
		want := map[string]string{"gadget_audit": RelWrites, "gadgets": RelReads}
		got := map[string]string{}
		for _, e := range edgesOfKind(f, "query", "table") {
			got[f.Nodes[e.To].Label] = e.Rel
		}
		for table, rel := range want {
			if got[table] != rel {
				t.Errorf("INSERT INTO gadget_audit … SELECT FROM gadgets: %s rel = %q, want %q", table, got[table], rel)
			}
		}
	} else {
		t.Error("POST /api/gadgets/audit not traced")
	}

	// Two implementations of Notifier, so the hop cannot be resolved. The curve
	// into that box must not read like a confident call.
	if f := byKey["POST /api/gadgets/{id}/notify"]; f != nil {
		edges := edgesOfKind(f, "handler", "unknown")
		if len(edges) == 0 {
			t.Fatal("the unresolvable Notifier hop produced no unknown node")
		}
		for _, e := range edges {
			if e.Rel != RelUnresolved {
				t.Errorf("handler→unknown rel = %q, want %q", e.Rel, RelUnresolved)
			}
		}
	} else {
		t.Error("POST /api/gadgets/{id}/notify not traced")
	}
}

// assertConditionalMiddleware pins the difference between a chain and a choice.
//
// The walk takes every arm of an if/else, which is right for routes and wrong
// for middleware: arms are mutually exclusive, so listing them flat claims a
// chain that can never run. merkle picks one of three CORS middlewares in an
// if/else-if/else and all three were shown as if they stacked.
func assertConditionalMiddleware(t *testing.T, byKey map[string]*Flow) {
	t.Helper()
	f := byKey["GET /healthz"]
	if f == nil {
		t.Fatal("GET /healthz not traced")
	}
	byLabel := map[string]MW{}
	for _, mw := range f.Middleware {
		byLabel[mw.Label] = mw
	}

	// The unconditional one stays unmarked — a Use outside a branch always runs.
	if mw, ok := byLabel["reqID(…)"]; !ok {
		t.Error("the unconditional middleware is missing")
	} else if mw.Branch != 0 {
		t.Errorf("reqID branch = %d, want 0 — it is not inside a conditional", mw.Branch)
	}

	dev, okDev := byLabel["devCORS(…)"]
	prod, okProd := byLabel["prodCORS(…)"]
	if !okDev || !okProd {
		t.Fatalf("both arms should still be listed, got %+v", byLabel)
	}
	if dev.Branch == 0 || prod.Branch == 0 {
		t.Errorf("an arm of an if/else is not marked conditional: dev=%d prod=%d", dev.Branch, prod.Branch)
	}
	if dev.Branch != prod.Branch {
		t.Errorf("the two arms are the SAME choice and must share a branch id, got %d and %d", dev.Branch, prod.Branch)
	}
	if dev.Arm == prod.Arm {
		t.Errorf("the two arms must differ, both are %d — that is what makes them exclusive", dev.Arm)
	}
}

func nodeOfKind(f *Flow, kind string) *Node {
	for _, n := range f.Nodes {
		if n.Kind == kind {
			return n
		}
	}
	return nil
}

func edgesOfKind(f *Flow, from, to string) []Edge {
	var out []Edge
	for _, e := range f.Edges {
		if f.Nodes[e.From].Kind == from && f.Nodes[e.To].Kind == to {
			out = append(out, e)
		}
	}
	return out
}

func edgeBetween(t *testing.T, f *Flow, from, to string) Edge {
	t.Helper()
	edges := edgesOfKind(f, from, to)
	if len(edges) != 1 {
		t.Fatalf("%s %s: want exactly one %s→%s edge, got %d", f.Method, f.Path, from, to, len(edges))
	}
	return edges[0]
}

// lineAt reads one backend-relative line of the fixture, so an assertion about
// a call site is checked against the source rather than against a number that
// silently rots when the fixture moves.
func lineAt(t *testing.T, file string, line int) string {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("testdata/fixtureapp", file))
	if err != nil {
		t.Fatalf("read %s: %v", file, err)
	}
	lines := strings.Split(string(body), "\n")
	if line < 1 || line > len(lines) {
		t.Fatalf("%s has no line %d", file, line)
	}
	return lines[line-1]
}

func TestTableRefs(t *testing.T) {
	cases := []struct {
		sql  string
		want []tableRef
	}{
		{"SELECT * FROM nodes", []tableRef{{"nodes", false}}},
		{"SELECT a FROM nodes n JOIN orgs o ON o.id=n.org_id", []tableRef{{"nodes", false}, {"orgs", false}}},
		{"DELETE FROM nodes WHERE id=$1", []tableRef{{"nodes", true}}},
		{"TRUNCATE TABLE nodes", []tableRef{{"nodes", true}}},
		// The case the statement-level verdict cannot express.
		{"INSERT INTO orgs (id) SELECT org_id FROM nodes", []tableRef{{"nodes", false}, {"orgs", true}}},
		// Written and read in one statement: the write is the stronger claim.
		{"UPDATE nodes SET n=x FROM nodes s WHERE s.id=nodes.id", []tableRef{{"nodes", true}}},
		{"WITH d AS (DELETE FROM nodes RETURNING id) INSERT INTO orgs SELECT id FROM d", []tableRef{{"nodes", true}, {"orgs", true}}},
		// A CTE name is not a table, whichever side of the statement it is on.
		{"WITH recent AS (SELECT * FROM nodes) SELECT * FROM recent", []tableRef{{"nodes", false}}},
	}
	known := map[string]string{"nodes": "001.sql", "orgs": "002.sql"}
	for _, c := range cases {
		got := tableRefs(c.sql, known)
		if len(got) != len(c.want) {
			t.Errorf("tableRefs(%q) = %+v, want %+v", c.sql, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("tableRefs(%q) = %+v, want %+v", c.sql, got, c.want)
				break
			}
		}
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
