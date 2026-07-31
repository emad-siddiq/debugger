// routers.go — which calls mean "here is a router", and how that router's
// patterns encode the method.
//
// WHY THIS IS A TABLE AND NOT AN `if`. The seed used to be two names inlined in a
// boolean — `NewRouter` and `NewMux` — and it was wrong for the whole of the
// standard library. It will be wrong again: every router package spells its
// constructor differently, and the list only grows.
//
// But the deciding argument is not the length of the list, it is that the entries
// are not interchangeable. A chi route puts the method in the CALL
// (`r.Get("/x", h)`) and a Go 1.22 stdlib route puts it in the PATTERN
// (`mux.HandleFunc("GET /x", h)`). A seed list of bare names cannot express that,
// so a list of names would have let `mux.HandleFunc("GET /x", h)` register a route
// whose path was literally `GET /x`. The dialect has to travel with the name, and
// that is what makes this data rather than a condition.
package main

import (
	"go/ast"
	"go/types"
	"strings"
)

// How a router's registration calls encode the HTTP method and the path.
type dialect uint8

const (
	// chi, gorilla/mux, goji and the fixture app: the method IS the call —
	// `r.Get(pattern, h)` — and the pattern is only a path.
	dialectChi dialect = iota
	// net/http since Go 1.22: `mux.HandleFunc("GET /items/{id}", h)`. One method,
	// `HandleFunc`, and the verb lives inside the pattern string.
	dialectStdlib
)

type routerCtor struct {
	// Import path the constructor must come from. Empty means match on the
	// function name alone — only safe for names distinctive enough that a
	// collision would be a router anyway.
	pkgPath string
	fn      string
	dialect dialect
	// What this entry is for, so the next person to add one knows the shape.
	why string
}

// The seed list. Ordered only for readability; matching is by name and package.
var routerCtors = []routerCtor{
	{fn: "NewRouter", dialect: dialectChi, why: "chi, gorilla/mux, and any hand-rolled router that copies the shape"},
	{fn: "NewMux", dialect: dialectChi, why: "goji"},
	// PACKAGE-QUALIFIED, and it has to be: `NewServeMux` is distinctive but the
	// dialect is not something to guess at from a name.
	{pkgPath: "net/http", fn: "NewServeMux", dialect: dialectStdlib, why: "the standard library — the default for a service written since Go 1.22"},
}

// Package-level registrations against `http.DefaultServeMux`. There is no router
// value to track here at all: `http.HandleFunc("/x", h)` in a `main` that never
// mentions a mux is a complete, working service, and it was invisible because the
// walk only started at constructor call sites.
var defaultMuxFuncs = map[string]bool{"Handle": true, "HandleFunc": true}

const netHTTP = "net/http"

// routerCtorOf reports the dialect of a constructor call, if it is one.
func routerCtorOf(call *ast.CallExpr, info *types.Info) (dialect, bool) {
	name, pkg := calleeName(call.Fun, info)
	if name == "" {
		return 0, false
	}
	for _, c := range routerCtors {
		if c.fn != name {
			continue
		}
		if c.pkgPath != "" && c.pkgPath != pkg {
			continue
		}
		return c.dialect, true
	}
	return 0, false
}

// isDefaultMuxCall reports `http.Handle(...)` / `http.HandleFunc(...)` — a
// registration on the package-level default mux.
func isDefaultMuxCall(call *ast.CallExpr, info *types.Info) bool {
	name, pkg := calleeName(call.Fun, info)
	return pkg == netHTTP && defaultMuxFuncs[name]
}

// calleeName splits a call target into its function name and, when the receiver
// is an imported PACKAGE rather than a value, that package's import path.
//
// The package half is resolved through the type info rather than the identifier
// text, so an aliased import (`nethttp "net/http"`) resolves the same as a plain
// one — and, more importantly, so a local variable that happens to be named
// `http` does not.
func calleeName(fun ast.Expr, info *types.Info) (name, pkgPath string) {
	switch f := fun.(type) {
	case *ast.SelectorExpr:
		name = f.Sel.Name
		if id, ok := f.X.(*ast.Ident); ok && info != nil {
			if pkgName, ok := info.Uses[id].(*types.PkgName); ok {
				pkgPath = pkgName.Imported().Path()
			}
		}
	case *ast.Ident:
		name = f.Name
	}
	return name, pkgPath
}

// --- Go 1.22 patterns -------------------------------------------------------

var httpMethods = map[string]bool{
	"GET": true, "HEAD": true, "POST": true, "PUT": true, "PATCH": true,
	"DELETE": true, "CONNECT": true, "OPTIONS": true, "TRACE": true,
}

// splitStdlibPattern pulls a `ServeMux` pattern apart into method, host and path.
//
// The grammar is `[METHOD ][HOST]/[PATH]`, and the reason this function has to
// exist is the first term: without it `mux.HandleFunc("GET /items/{id}", h)`
// registers a route whose *path* is `GET /items/{id}`, which is what a parser
// written for the pre-1.22 form does.
//
// WHERE THE LINE IS DRAWN, deliberately:
//
//   - The METHOD is split off, and only when the leading token is a method the
//     HTTP spec defines. A pattern beginning `SEARCH /x` is left whole rather
//     than guessed at — Go itself accepts any token there, but treating an
//     unknown word as a method would silently truncate a real path.
//   - The HOST is split off and RETURNED, so the caller can note it, but it does
//     not become part of the path. Host-scoped routes are rare and a path that
//     silently carried a hostname would group wrongly in the rail.
//   - Wildcards are left EXACTLY AS WRITTEN. `{id}`, `{path...}` and `{$}` are
//     Go's own syntax, a Go developer reads them, and rewriting them would lose a
//     distinction the language makes: `/x/{$}` (exact) and `/x/` (subtree) differ,
//     and normalising either one collapses them onto each other.
//   - Precedence and conflict rules are not modelled. They decide which pattern
//     WINS at request time; this is a list of what is registered.
func splitStdlibPattern(pattern string) (method, host, path string) {
	method, rest := "*", strings.TrimSpace(pattern)
	if i := strings.IndexAny(rest, " \t"); i > 0 && httpMethods[rest[:i]] {
		method, rest = rest[:i], strings.TrimLeft(rest[i:], " \t")
	}
	if !strings.HasPrefix(rest, "/") {
		// A HOST CANNOT CONTAIN A SPACE. Without that check an unrecognised
		// leading token becomes the host and the path is silently truncated:
		// `SEARCH /x` parsed as host `SEARCH ` + path `/x`, which is the same
		// class of mistake as reading the method as part of the path, one term
		// along. Caught by the table below, not by review.
		if j := strings.Index(rest, "/"); j > 0 && !strings.ContainsAny(rest[:j], " \t") {
			host, rest = rest[:j], rest[j:]
		}
	}
	return method, host, rest
}
