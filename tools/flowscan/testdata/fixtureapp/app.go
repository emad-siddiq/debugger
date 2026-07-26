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
