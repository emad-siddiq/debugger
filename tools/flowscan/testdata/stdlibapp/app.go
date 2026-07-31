// app.go — the standard library's router, in the shapes a service written since
// Go 1.22 actually uses.
//
// This fixture exists because the tracer was blind to all of it. flowscan seeded
// its walk on `NewRouter()` / `NewMux()`, so a project using `http.NewServeMux`
// traced ZERO routes — which was true of Burrow's own scaffold and of
// prometheus/alertmanager, neither of which is unusual.
//
// Every shape below is here to be traced, and the golden file records what came
// out. Nothing in this file imports anything outside the standard library.
package stdlibapp

import (
	"net/http"

	"stdlibapp/pg"
)

type App struct {
	Pool *pg.Pool
}

// The Go 1.22 form: the METHOD IS INSIDE THE PATTERN. A parser written for the
// older `mux.HandleFunc("/items/", h)` shape reads `GET /items/{id}` as a path.
func (a *App) Routes() *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", a.healthz)
	mux.HandleFunc("GET /api/widgets", a.listWidgets)
	mux.HandleFunc("POST /api/widgets", a.createWidget)
	mux.HandleFunc("GET /api/widgets/{id}", a.getWidget)
	mux.HandleFunc("DELETE /api/widgets/{id}", a.deleteWidget)

	// A wildcard that swallows the rest of the path, and the exact-match marker.
	mux.HandleFunc("GET /assets/{path...}", a.serveAsset)
	mux.HandleFunc("GET /exact/{$}", a.exactOnly)

	// No method: legal, and means "any method".
	mux.HandleFunc("/legacy", a.legacy)

	// A SUBTREE pattern. The trailing slash is semantic — `/debug/` matches
	// everything under it and `/debug` matches only itself — so it survives.
	mux.Handle("/debug/", http.StripPrefix("/debug", a.debugHandler()))

	// A registration made in another function that receives the mux.
	registerAdmin(mux, a.Pool)

	return mux
}

// registerAdmin — the register-func shape, with the mux passed in. The walker
// already followed this for chi; it has to follow it here too.
func registerAdmin(mux *http.ServeMux, db *pg.Pool) {
	mux.HandleFunc("POST /admin/reload", func(w http.ResponseWriter, r *http.Request) {
		_ = db.Exec(r.Context(), `UPDATE settings SET reloaded_at = now()`)
	})
}

func (a *App) healthz(w http.ResponseWriter, r *http.Request) {}

func (a *App) listWidgets(w http.ResponseWriter, r *http.Request) {
	_, _ = a.Pool.Query(r.Context(), `SELECT id, name FROM widgets ORDER BY name`)
}

func (a *App) createWidget(w http.ResponseWriter, r *http.Request) {
	_ = a.Pool.Exec(r.Context(), `INSERT INTO widgets (name) VALUES ($1)`)
}

func (a *App) getWidget(w http.ResponseWriter, r *http.Request) {
	_ = a.Pool.QueryRow(r.Context(), `SELECT id, name FROM widgets WHERE id = $1`)
}

func (a *App) deleteWidget(w http.ResponseWriter, r *http.Request) {
	_ = a.Pool.Exec(r.Context(), `DELETE FROM widgets WHERE id = $1`)
}

func (a *App) serveAsset(w http.ResponseWriter, r *http.Request) {}
func (a *App) exactOnly(w http.ResponseWriter, r *http.Request)  {}
func (a *App) legacy(w http.ResponseWriter, r *http.Request)     {}

// A handler that is a COMPOSED EXPRESSION rather than a named function — the
// shape alertmanager registers. It cannot be followed, and the route must still
// be listed with a reason rather than dropped.
func (a *App) debugHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})
}
