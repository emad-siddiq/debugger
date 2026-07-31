// app.go — router wiring in the nodewatch shape: root Use stack, /api Route
// closure with scoped middleware, register funcs on the App receiver, a
// cross-package register func taking the injected store, and a mount-base
// string parameter.
package fixtureapp

import (
	"net/http"

	"fixtureapp/gadgets"
	"fixtureapp/pg"
	"fixtureapp/widgets"
)

type App struct {
	Pool *pg.Pool
}

func reqID() Middleware  { return nil }
func orgCtx() Middleware { return nil }

func Health(db *pg.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		_ = db.Exec(r.Context(), `SELECT 1`)
	}
}

func (a *App) setupRouter() Router {
	r := NewRouter()
	r.Use(reqID())

	r.Get("/healthz", Health(a.Pool))

	r.Route("/api", func(r Router) {
		r.Use(orgCtx())
		a.registerWidgetRoutes(r)
		registerGadgetRoutes(r, &gadgets.PgxGadgetStore{Pool: a.Pool})
		a.registerSubRoutes(r, "/v1")
	})
	return r
}

func (a *App) registerWidgetRoutes(r Router) {
	r.Get("/widgets", widgets.ListWidgets(a.Pool))
	r.Delete("/widgets/{id}", widgets.DeleteWidget(a.Pool))
	r.Get("/widgets/search", widgets.SearchWidgets(a.Pool))
}

func registerGadgetRoutes(r Router, s *gadgets.PgxGadgetStore) {
	r.Get("/gadgets/{id}", gadgets.GetGadget(s))
	r.Post("/gadgets", gadgets.CreateGadget(s))
	r.Post("/gadgets/{id}/notify", gadgets.NotifyGadget(gadgets.PickNotifier()))
}

func (a *App) registerSubRoutes(r Router, base string) {
	r.Route(base+"/sub", func(r Router) {
		r.Get("/things", widgets.ListWidgets(a.Pool))
	})
}

// setupInstrumented — the BUILDER CHAIN shapes, both of them.
//
// `NewRouter().WithInstrumentation(h)` is a constructor that is the receiver of a
// method call rather than the bare right-hand side of an assignment. Tracking only
// the bare form is why `alertmanager` reported 2 routes and had 22.
//
// `r = r.WithPrefix("/v2")` is the same chain shape with a string argument, and
// that one is NOT safe to follow through: we do not model the prefix, so every
// path after it may be wrong. It is noted instead, and the routes keep their
// unprefixed paths — which is what the app serves when the prefix is empty.
func (a *App) setupInstrumented() Router {
	r := NewRouter().WithInstrumentation(nil)
	r.Get("/instrumented", widgets.ListWidgets(a.Pool))
	r = r.WithPrefix("/v2")
	r.Get("/after-prefix", widgets.ListWidgets(a.Pool))
	return r
}
