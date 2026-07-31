// pkgvar.go — a router built at FILE SCOPE.
//
// `var mux = http.NewServeMux()` is a real Go idiom and it defeats a walk seeded
// on function bodies twice over: the constructor is in no body, so nothing is
// seeded, and the registrations below are in a scope that therefore never runs.
//
// It is NOT the same problem as a builder chain. That one is a tracking failure
// inside a function the walk already visits; this one is a seeding failure, and
// no amount of chain-following or seed-list growth reaches it.
package stdlibapp

import (
	"net/http"
)

var adminMux = http.NewServeMux()

func init() {
	adminMux.HandleFunc("GET /pkgvar/status", pkgStatus)
	adminMux.Handle("/pkgvar/sub/", http.StripPrefix("/pkgvar/sub", http.NotFoundHandler()))
}

func pkgStatus(w http.ResponseWriter, r *http.Request) {}
