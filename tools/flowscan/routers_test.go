package main

import "testing"

// TestSplitStdlibPattern — the Go 1.22 pattern grammar, `[METHOD ][HOST]/[PATH]`.
//
// The first term is why this exists. Without splitting it,
// `mux.HandleFunc("GET /items/{id}", h)` registers a route whose PATH is
// `GET /items/{id}` — which is what a parser written for the pre-1.22 form does,
// and what flowscan did.
func TestSplitStdlibPattern(t *testing.T) {
	cases := []struct {
		in                 string
		method, host, path string
		why                string
	}{
		// The shape this work order exists for.
		{"GET /items/{id}", "GET", "", "/items/{id}", "method inside the pattern"},
		{"POST /api/widgets", "POST", "", "/api/widgets", ""},
		{"DELETE /x", "DELETE", "", "/x", ""},

		// No method is legal and means "any method".
		{"/legacy", "*", "", "/legacy", "no method is legal"},
		{"/", "*", "", "/", ""},

		// Wildcards are LEFT AS WRITTEN. They are Go's own syntax and rewriting
		// them loses a distinction the language makes.
		{"GET /assets/{path...}", "GET", "", "/assets/{path...}", "multi-segment wildcard"},
		{"GET /exact/{$}", "GET", "", "/exact/{$}", "{$} means exact, and /x/{$} != /x/"},

		// A trailing slash is a subtree match, and is not the same route as the
		// path without it.
		{"/debug/", "*", "", "/debug/", "subtree"},

		// Hosts come out separately: a path silently carrying a hostname would
		// group wrongly in the rail.
		{"GET example.com/x", "GET", "example.com", "/x", "host is split off, not prefixed"},
		{"example.com/", "*", "example.com", "/", ""},

		// An unknown leading token is NOT a method. Go accepts any token there;
		// guessing would silently truncate a real path.
		{"SEARCH /x", "*", "", "SEARCH /x", "unknown verb is left whole rather than guessed"},
		{"get /x", "*", "", "get /x", "methods are upper-case; lower-case is not one"},

		// Degenerate inputs must not panic or invent segments.
		{"", "*", "", "", ""},
		{"   ", "*", "", "", ""},
	}
	for _, c := range cases {
		method, host, path := splitStdlibPattern(c.in)
		if method != c.method || host != c.host || path != c.path {
			t.Errorf("splitStdlibPattern(%q) = (%q, %q, %q), want (%q, %q, %q) %s",
				c.in, method, host, path, c.method, c.host, c.path, c.why)
		}
	}
}

// TestRouterCtorTable — the seed list is data, so assert the data.
//
// It has been wrong once (for the whole standard library) and will grow. The
// property that matters is not its length: it is that a bare-name entry matches
// any package while a qualified entry does not, because that is what stops
// `NewServeMux` being claimed by something that is not net/http.
func TestRouterCtorTable(t *testing.T) {
	byName := map[string]routerCtor{}
	for _, c := range routerCtors {
		if c.why == "" {
			t.Errorf("seed entry %q has no `why` — the next person to add one needs the shape", c.fn)
		}
		byName[c.fn] = c
	}

	if _, ok := byName["NewServeMux"]; !ok {
		t.Fatal("net/http is not seeded")
	}
	if byName["NewServeMux"].pkgPath != netHTTP {
		t.Error("NewServeMux must be package-qualified: the dialect is not guessable from the name")
	}
	if byName["NewServeMux"].dialect != dialectStdlib {
		t.Error("net/http is not the chi dialect — its method lives in the pattern")
	}
	// chi's entry stays name-only: the shape is copied by hand-rolled routers
	// (the fixture app is one), and requiring an import path would lose them.
	if byName["NewRouter"].pkgPath != "" {
		t.Error("NewRouter is deliberately name-only")
	}
	if byName["NewRouter"].dialect != dialectChi {
		t.Error("NewRouter must be the chi dialect")
	}

	// The default mux has no constructor, so it is seeded separately.
	for _, fn := range []string{"Handle", "HandleFunc"} {
		if !defaultMuxFuncs[fn] {
			t.Errorf("http.%s is not recognised as a default-mux registration", fn)
		}
	}
}
