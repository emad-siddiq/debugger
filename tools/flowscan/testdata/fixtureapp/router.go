// router.go — a minimal chi-shaped router so the walker can be exercised
// without importing chi (flowscan's detection is structural).
package fixtureapp

import "net/http"

type Middleware func(http.Handler) http.Handler

type Router interface {
	Get(pattern string, h http.HandlerFunc)
	Post(pattern string, h http.HandlerFunc)
	Delete(pattern string, h http.HandlerFunc)
	Use(mw ...Middleware)
	Route(pattern string, fn func(Router)) Router
	Group(fn func(Router)) Router

	// BUILDER STEPS. Both return the router, and the difference between them is
	// the whole rule: a step taking a STRING may move every path behind it, and a
	// step taking anything else cannot.
	WithInstrumentation(h func(http.Handler) http.Handler) Router
	WithPrefix(prefix string) Router
}

func NewRouter() Router { return nil }
