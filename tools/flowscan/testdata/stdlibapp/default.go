// default.go — the shape with no router value at all.
//
// `http.HandleFunc` registers on `http.DefaultServeMux`. There is no mux
// variable, no constructor call, and nothing for a walk seeded on constructors
// to start from — which is why this was invisible. It is also the first thing a
// Go tutorial teaches, so it is not a corner case.
package stdlibapp

import (
	"net/http"

	"stdlibapp/pg"
)

func RunDefault(db *pg.Pool) error {
	http.HandleFunc("GET /ping", func(w http.ResponseWriter, r *http.Request) {})
	http.HandleFunc("POST /api/events", func(w http.ResponseWriter, r *http.Request) {
		_ = db.Exec(r.Context(), `INSERT INTO events (kind) VALUES ($1)`)
	})
	http.Handle("/static/", http.StripPrefix("/static", http.FileServer(http.Dir("public"))))

	return http.ListenAndServe(":8080", nil)
}
