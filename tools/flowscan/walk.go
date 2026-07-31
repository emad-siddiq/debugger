// walk.go — interprocedural walk of the chi router wiring.
//
// Starts at every function that calls NewRouter()/NewMux(), tracks which
// idents are "the router", and follows r.Route/r.Group closures and calls to
// in-module functions that take the router as an argument (register funcs).
// Accumulates the path prefix, the r.Use middleware stack, and constant string
// arguments bound to parameters (mount-base params like `base string`).
// Terminal registrations (r.Get/Post/…) are recorded with the fully resolved
// path. All structural — no chi import required — so it works on any
// chi-shaped router including test fixtures.
package main

import (
	"go/ast"
	"go/token"
	"go/types"
	"strconv"
	"strings"

	"golang.org/x/tools/go/packages"
)

type terminal struct {
	method string
	path   string
	// Host prefix from a Go 1.22 pattern (`example.com/x`), when there was one.
	// Kept off the path: a path silently carrying a hostname groups wrongly.
	host string
	// Registration site, so a note can be withdrawn when the same line turns out
	// to have been traced after all — see discoverRouters.
	pos         token.Pos
	handlerExpr ast.Expr
	pkg         *packages.Package
	mw          []MW
}

type routerWalker struct {
	a          *analyzer
	terminals  []*terminal
	visiting   map[*types.Func]bool
	unfollowed []Unfollowed
	noted      map[string]bool
}

type walkScope struct {
	pkg     *packages.Package
	routers map[types.Object]bool
	prefix  string
	mw      []MW
	consts  map[types.Object]string
	// Which router library this scope's registrations belong to. It decides
	// whether the HTTP method comes from the call or from inside the pattern —
	// see routers.go.
	dialect dialect
}

var verbMethods = map[string]string{
	"Get": "GET", "Post": "POST", "Put": "PUT", "Patch": "PATCH",
	"Delete": "DELETE", "Del": "DELETE", "Head": "HEAD", "Options": "OPTIONS",
	"Handle": "*", "HandleFunc": "*",
}

func discoverTerminals(a *analyzer) []*terminal {
	terminals, _ := discoverRouters(a)
	return terminals
}

// discoverRouters runs the walk and returns the terminals it recorded plus the
// routers it recognised and could not follow.
func discoverRouters(a *analyzer) ([]*terminal, []Unfollowed) {
	w := &routerWalker{a: a, visiting: map[*types.Func]bool{}, noted: map[string]bool{}}
	pkgRouters := packageRouters(a)
	for _, site := range a.decls {
		if site.decl.Body == nil {
			continue
		}
		d, ok := seedDialect(site.decl.Body, site.pkg.TypesInfo)
		if !ok {
			// No construction in this body — but a router built at FILE SCOPE may
			// be registered on from here, and `func init()` is where that happens.
			d, ok = usesPackageRouter(site, pkgRouters)
			if !ok {
				continue
			}
		}
		sc := &walkScope{
			pkg:     site.pkg,
			routers: map[types.Object]bool{},
			consts:  map[types.Object]string{},
			dialect: d,
		}
		// File-scope routers of this dialect are in scope everywhere in the package.
		for obj, rd := range pkgRouters {
			if rd == d {
				sc.routers[obj] = true
			}
		}
		w.walkStmts(site.decl.Body.List, sc)
	}
	// WITHDRAW NOTES THAT TURNED OUT TO BE WRONG.
	//
	// One function can be reached by two seeded walks — `api.Register` builds a
	// ServeMux (its own stdlib seed) and also takes a chi router (reached from
	// `app.go`) — and in the chi walk the mux is untracked, which looks exactly
	// like an unfollowable router. It is not: the stdlib walk traced those same
	// two lines. A note on a line that produced a route is a false alarm, and a
	// gate that cries wolf is the failure mode this whole state exists to avoid.
	traced := map[string]bool{}
	for _, t := range w.terminals {
		file, line, _ := a.relPos(t.pos)
		traced[file+":"+strconv.Itoa(line)] = true
	}
	kept := w.unfollowed[:0]
	for _, u := range w.unfollowed {
		if !traced[u.File+":"+strconv.Itoa(u.Line)] {
			kept = append(kept, u)
		}
	}
	return w.terminals, kept
}

// packageRouters finds routers built at FILE SCOPE.
//
//	var mux = http.NewServeMux()
//
//	func init() { mux.HandleFunc("GET /x", h) }
//
// A DIFFERENT PROBLEM FROM A BUILDER CHAIN, which is why it needs different code.
// A builder chain is a TRACKING failure inside a function the walk already visits;
// this is a SEEDING failure — the constructor is in no function body at all, so no
// function is ever seeded and the registrations are in a scope the walk never
// starts. Following the chain could not have helped, and nor could a better seed
// list: there is nothing wrong with the constructor, only with where it sits.
//
// The registrations then look exactly like registrations on an untracked router,
// which is the state this work order made visible — so before this existed the
// shape produced a note. Now it produces routes.
func packageRouters(a *analyzer) map[types.Object]dialect {
	out := map[types.Object]dialect{}
	for _, p := range a.pkgs {
		if p.TypesInfo == nil {
			continue
		}
		for _, f := range p.Syntax {
			for _, decl := range f.Decls {
				gen, ok := decl.(*ast.GenDecl)
				if !ok || gen.Tok != token.VAR {
					continue
				}
				for _, spec := range gen.Specs {
					vs, ok := spec.(*ast.ValueSpec)
					if !ok {
						continue
					}
					for i, val := range vs.Values {
						call, isCall := val.(*ast.CallExpr)
						if !isCall || i >= len(vs.Names) {
							continue
						}
						if d, is := routerConstruction(call, p.TypesInfo); is {
							if obj := p.TypesInfo.Defs[vs.Names[i]]; obj != nil {
								out[obj] = d
							}
						}
					}
				}
			}
		}
	}
	return out
}

// usesPackageRouter reports a body that mentions a file-scope router.
func usesPackageRouter(site declSite, pkgRouters map[types.Object]dialect) (dialect, bool) {
	if len(pkgRouters) == 0 || site.pkg.TypesInfo == nil {
		return 0, false
	}
	var found dialect
	ok := false
	ast.Inspect(site.decl.Body, func(n ast.Node) bool {
		id, isIdent := n.(*ast.Ident)
		if !isIdent {
			return !ok
		}
		if d, is := pkgRouters[site.pkg.TypesInfo.Uses[id]]; is {
			found, ok = d, true
		}
		return !ok
	})
	return found, ok
}

// seedDialect reports whether this function body is where a router gets wired,
// and in which dialect.
//
// TWO WAYS IN, and the second one is the whole point of this work order. The
// first is a constructor call — `chi.NewRouter()`, `http.NewServeMux()`. The
// second is a package-level registration on `http.DefaultServeMux`:
//
//	func main() {
//	    http.HandleFunc("/api/hello", hello)
//	    http.ListenAndServe(":8080", nil)
//	}
//
// which is a complete service with no router VALUE anywhere in it. A walk that
// starts only at constructor call sites cannot see it at all.
func seedDialect(body *ast.BlockStmt, info *types.Info) (dialect, bool) {
	var found dialect
	ok := false
	ast.Inspect(body, func(n ast.Node) bool {
		call, isCall := n.(*ast.CallExpr)
		if !isCall {
			return !ok
		}
		if d, is := routerConstruction(call, info); is {
			found, ok = d, true
		} else if isDefaultMuxCall(call, info) {
			found, ok = dialectStdlib, true
		}
		return !ok
	})
	return found, ok
}

// routerConstruction reports a call that PRODUCES a fresh router.
//
// Structural first: any call whose result type is router-shaped. That reaches
// `route.New()` and every other package nobody listed, which a name table cannot.
// The name table is the fallback, for the constructor whose result type is too
// thin to carry the shape.
//
// "Fresh" is the load-bearing word. `route.New().WithInstrumentation(h)` also has
// a router result type, and seeding on it as well as on `route.New()` would walk
// the same wiring twice. A call whose RECEIVER is already router-shaped is a step
// in a builder chain, not a construction — `routerStep` handles those.
func routerConstruction(call *ast.CallExpr, info *types.Info) (dialect, bool) {
	if info == nil {
		return 0, false
	}
	if _, isStep := routerReceiver(call, info); isStep {
		return 0, false
	}
	if d, ok := routerShapeOf(info.TypeOf(call)); ok {
		return d, true
	}
	return routerCtorOf(call, info)
}

// routerReceiver returns the receiver expression of a method call made ON a
// router-shaped value — i.e. `x` in `x.WithPrefix(p)`.
func routerReceiver(call *ast.CallExpr, info *types.Info) (ast.Expr, bool) {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return nil, false
	}
	// A package qualifier is not a receiver: `route.New()` selects on the PACKAGE.
	if id, isIdent := sel.X.(*ast.Ident); isIdent {
		if _, isPkg := info.Uses[id].(*types.PkgName); isPkg {
			return nil, false
		}
	}
	if _, isRouter := routerShapeOf(info.TypeOf(sel.X)); !isRouter {
		return nil, false
	}
	return sel.X, true
}

// routerValued unwraps a BUILDER CHAIN back to the thing that made the router.
//
//	router := route.New().WithInstrumentation(h)   // alertmanager, app/app.go:516
//	router = router.WithPrefix(routePrefix)        // …and then reassigned
//
// Both are the same rule: a method call on a router-shaped value that RETURNS THE
// SAME TYPE is still that router. The type equality is what makes it safe —
// `r.ServeHTTP(w, req)` and `r.Handler(req)` are also method calls on a router and
// neither yields one, so neither is followed.
//
// This is general by construction: it names no package and no method, only the
// shape of the value and the identity of the type.
type routerValue struct {
	dialect  dialect
	isRouter bool
	// A builder step that takes a STRING may have changed the paths —
	// `WithPrefix`, `PathPrefix`, `Subrouter`. We do not model it, and following
	// through one anyway would register `/status` where the app serves
	// `/api/v1/status`.
	//
	// A WRONG PATH IS WORSE THAN A MISSING ONE, so the chain is marked instead and
	// the caller records an unfollowed router. A step taking anything else —
	// `WithInstrumentation(h)` — cannot move a path, so it is followed.
	//
	// This is the general form of the rule and it names no method and no package:
	// what matters is the ARGUMENT'S TYPE, not the builder's vocabulary.
	opaqueStep string
}

func (w *routerWalker) routerValued(expr ast.Expr, sc *walkScope) routerValue {
	info := sc.pkg.TypesInfo
	switch e := expr.(type) {
	case *ast.Ident:
		if obj := info.Uses[e]; obj != nil && sc.routers[obj] {
			return routerValue{dialect: sc.dialect, isRouter: true}
		}
	case *ast.CallExpr:
		if recv, isStep := routerReceiver(e, info); isStep {
			// A builder step only if it hands back the same type it was called on.
			// `r.ServeHTTP(w, req)` and `r.Handler(req)` are method calls on a
			// router too, and neither yields one.
			if !types.Identical(info.TypeOf(e), info.TypeOf(recv)) {
				return routerValue{}
			}
			base := w.routerValued(recv, sc)
			if base.isRouter && base.opaqueStep == "" && takesString(e, info) {
				if sel, ok := e.Fun.(*ast.SelectorExpr); ok {
					base.opaqueStep = sel.Sel.Name
				}
			}
			return base
		}
		if d, ok := routerConstruction(e, info); ok {
			return routerValue{dialect: d, isRouter: true}
		}
	}
	return routerValue{}
}

// takesString reports a call with at least one string argument.
func takesString(call *ast.CallExpr, info *types.Info) bool {
	for _, arg := range call.Args {
		if b, ok := types.Unalias(info.TypeOf(arg)).(*types.Basic); ok && b.Kind() == types.String {
			return true
		}
	}
	return false
}

// note records a router the walk RECOGNISED and could not follow.
//
// Not a route, and deliberately not a fifth route bucket: we do not know how many
// routes are behind it, so there is nothing to file in `unknown` — that state
// means "the route is real and the handler did not resolve", which presumes a
// route. This is one level up, and it is the difference between "this app has 13
// routes" and "I found 13 and there is a router in here I cannot read".
func (w *routerWalker) note(expr ast.Expr, reason string) {
	file, line, _ := w.a.relPos(expr.Pos())
	key := file + ":" + strconv.Itoa(line)
	if w.noted[key] {
		return
	}
	w.noted[key] = true
	w.unfollowed = append(w.unfollowed, Unfollowed{File: file, Line: line, Reason: reason})
}

// walkStmts processes statements in order — chi requires Use before
// registrations in a scope, so sequential accumulation matches semantics.
func (w *routerWalker) walkStmts(stmts []ast.Stmt, sc *walkScope) {
	for _, stmt := range stmts {
		switch s := stmt.(type) {
		case *ast.AssignStmt:
			for i, rhs := range s.Rhs {
				if i >= len(s.Lhs) {
					break
				}
				rv := w.routerValued(rhs, sc)
				if !rv.isRouter || rv.dialect != sc.dialect {
					continue
				}
				if rv.opaqueStep != "" {
					// NOTE IT AND KEEP GOING, deliberately. Dropping the router here
					// would lose every route behind it; keeping it reports them at
					// the UNPREFIXED path, which is what the app serves whenever the
					// prefix is empty — alertmanager's is `if routePrefix != "/"`,
					// so the common path is exactly what comes out. The note carries
					// the caveat, which is the honest version of both.
					w.note(rhs, opaqueReason(rv.opaqueStep))
				}
				if id, ok := s.Lhs[i].(*ast.Ident); ok {
					if obj := sc.pkg.TypesInfo.Defs[id]; obj != nil {
						sc.routers[obj] = true
					} else if obj := sc.pkg.TypesInfo.Uses[id]; obj != nil {
						sc.routers[obj] = true
					}
				}
			}
			// A register func called in an ASSIGNMENT rather than a bare statement.
			//
			//	mux := apih.Register(router, routePrefix)   // alertmanager, app.go:528
			//
			// Only `*ast.ExprStmt` reached the walker, so a register func whose
			// return value someone kept was never followed — and everything behind
			// it was invisible with no sign that anything had been skipped. The
			// sibling calls two lines up are plain statements and were followed,
			// which is why the gap looked like a router problem rather than a
			// statement-shape one.
			for _, rhs := range s.Rhs {
				if call, ok := rhs.(*ast.CallExpr); ok {
					w.handleCall(call, sc)
				}
			}
		case *ast.ExprStmt:
			if call, ok := s.X.(*ast.CallExpr); ok {
				w.handleCall(call, sc)
			}
		case *ast.IfStmt:
			w.walkStmts(s.Body.List, sc)
			switch e := s.Else.(type) {
			case *ast.BlockStmt:
				w.walkStmts(e.List, sc)
			case *ast.IfStmt:
				w.walkStmts([]ast.Stmt{e}, sc)
			}
		case *ast.BlockStmt:
			w.walkStmts(s.List, sc)
		case *ast.ForStmt:
			w.walkStmts(s.Body.List, sc)
		case *ast.RangeStmt:
			w.walkStmts(s.Body.List, sc)
		case *ast.SwitchStmt:
			for _, c := range s.Body.List {
				if cc, ok := c.(*ast.CaseClause); ok {
					w.walkStmts(cc.Body, sc)
				}
			}
		}
	}
}

func (w *routerWalker) handleCall(call *ast.CallExpr, sc *walkScope) {
	// `http.HandleFunc(pattern, h)` — the default mux. There is no receiver to
	// recognise, so this is checked before the router-value path.
	if isDefaultMuxCall(call, sc.pkg.TypesInfo) && len(call.Args) >= 2 {
		w.record("*", call.Args[0], call.Args[1], sc.withDialect(dialectStdlib), call.Pos())
		return
	}
	if sel, ok := call.Fun.(*ast.SelectorExpr); ok {
		// r.With(mw…).Get(path, h) — unwrap the With chain.
		if inner, ok := sel.X.(*ast.CallExpr); ok {
			if innerSel, ok := inner.Fun.(*ast.SelectorExpr); ok &&
				innerSel.Sel.Name == "With" && w.isRouter(innerSel.X, sc) {
				chained := *sc
				chained.mw = append(append([]MW{}, sc.mw...), w.mwLabels(inner.Args, sc)...)
				w.handleRouterMethod(sel.Sel.Name, call, &chained)
				return
			}
		}
		if w.isRouter(sel.X, sc) {
			w.handleRouterMethod(sel.Sel.Name, call, sc)
			return
		}
		// A registration on a router-shaped value this scope never tracked. The
		// router is RECOGNISED — its type says so — and where it came from is not
		// something the walk can see: a struct field, an interface, a package-level
		// var, a parameter of a function nobody called with a router we followed.
		// That is the state this work order exists to make visible.
		if verbMethods[sel.Sel.Name] != "" || sel.Sel.Name == "Route" || sel.Sel.Name == "Mount" {
			if _, shaped := routerShapeOf(sc.pkg.TypesInfo.TypeOf(sel.X)); shaped {
				w.note(call, "registrations on a router this walk never tracked — it reaches "+
					"here from somewhere the walk cannot follow (a field, an interface, a "+
					"package-level var, or a caller that was not itself traced)")
				return
			}
		}
	}
	// Call to an in-module function that receives the router → recurse.
	w.maybeRecurse(call, sc)
}

func (w *routerWalker) isRouter(expr ast.Expr, sc *walkScope) bool {
	rv := w.routerValued(expr, sc)
	if rv.isRouter && rv.opaqueStep != "" {
		w.note(expr, opaqueReason(rv.opaqueStep))
		return false
	}
	return rv.isRouter
}

// opaqueReason describes a builder step we followed but could not interpret.
//
// The wording matters and an earlier draft got it wrong: it said registrations
// were "left untraced", while the code kept tracing them. A note that contradicts
// the behaviour is worse than no note, because it is the thing a reader trusts
// when the numbers look odd.
func opaqueReason(method string) string {
	return "the router passes through ." + method + "(…), which takes a string and may " +
		"prefix every path behind it. Those routes are listed at their UNPREFIXED paths — " +
		"right when the prefix is empty, short by it when it is not."
}

func (w *routerWalker) handleRouterMethod(name string, call *ast.CallExpr, sc *walkScope) {
	switch {
	case verbMethods[name] != "" && len(call.Args) >= 2:
		w.record(verbMethods[name], call.Args[0], call.Args[1], sc, call.Pos())
	case (name == "Method" || name == "MethodFunc") && len(call.Args) >= 3:
		method, _ := foldString(call.Args[0], sc.pkg.TypesInfo, sc.consts)
		w.record(strings.ToUpper(method), call.Args[1], call.Args[2], sc, call.Pos())
	case name == "Use":
		sc.mw = append(sc.mw, w.mwLabels(call.Args, sc)...)
	case name == "Route" && len(call.Args) >= 2:
		prefix, ok := foldString(call.Args[0], sc.pkg.TypesInfo, sc.consts)
		if !ok {
			prefix = "⟨dyn⟩"
		}
		if lit, isLit := call.Args[1].(*ast.FuncLit); isLit {
			w.walkClosure(lit, joinPath(sc.prefix, prefix), sc)
		}
	case name == "Group" && len(call.Args) >= 1:
		if lit, isLit := call.Args[0].(*ast.FuncLit); isLit {
			w.walkClosure(lit, sc.prefix, sc)
		}
	case name == "Mount" && len(call.Args) >= 2:
		w.record("*", call.Args[0], call.Args[1], sc, call.Pos())
	}
}

// isRouterCtor: a constructor call whose dialect matches the scope we are in.
// The dialect is fixed when the walk is seeded, so a scope never mixes the two.
func isRouterCtor(call *ast.CallExpr, sc *walkScope) bool {
	d, ok := routerCtorOf(call, sc.pkg.TypesInfo)
	return ok && d == sc.dialect
}

// withDialect returns a shallow copy in another dialect, for the default-mux
// case where there is no router value whose construction fixed one.
func (sc *walkScope) withDialect(d dialect) *walkScope {
	if sc.dialect == d {
		return sc
	}
	child := *sc
	child.dialect = d
	return &child
}

// `at` is the REGISTRATION CALL's position, not the pattern argument's. The two
// differ on a multi-line call, and the note-withdrawal below keys on it: a note
// filed against `mux.Handle(` on one line must be withdrawn by a route recorded
// from an argument three lines down.
func (w *routerWalker) record(method string, pathExpr, handler ast.Expr, sc *walkScope, at token.Pos) {
	p, folded := foldString(pathExpr, sc.pkg.TypesInfo, sc.consts)
	host := ""
	if !folded {
		p = "⟨dyn⟩"
	} else if sc.dialect == dialectStdlib && method == "*" {
		// The method lives INSIDE a Go 1.22 pattern, so it has to come out before
		// the rest can be treated as a path. Only when the caller could not supply
		// one: chi's own `Handle` also arrives as "*" but its pattern is a path.
		//
		// Guarded on `folded` because an unresolved pattern is the sentinel, not a
		// string anyone should be parsing.
		method, host, p = splitStdlibPattern(p)
	}
	full := joinPath(sc.prefix, p)
	if sc.dialect == dialectStdlib && folded && strings.HasSuffix(p, "/") && len(p) > 1 {
		// A trailing slash is SEMANTIC in a ServeMux pattern — `/api/v2/` matches
		// the subtree and `/api/v2` matches exactly that one path. joinPath trims
		// it, which is right for chi and would merge two different routes here.
		full = strings.TrimSuffix(full, "/") + "/"
	}
	w.terminals = append(w.terminals, &terminal{
		method:      method,
		path:        full,
		host:        host,
		pos:         at,
		handlerExpr: handler,
		pkg:         sc.pkg,
		mw:          append([]MW{}, sc.mw...),
	})
}

// walkClosure enters an r.Route/r.Group func literal: its router param becomes
// the tracked router in the child scope.
func (w *routerWalker) walkClosure(lit *ast.FuncLit, prefix string, sc *walkScope) {
	child := &walkScope{
		pkg:     sc.pkg,
		routers: map[types.Object]bool{},
		prefix:  prefix,
		mw:      append([]MW{}, sc.mw...),
		consts:  sc.consts,
		dialect: sc.dialect,
	}
	if lit.Type.Params != nil && len(lit.Type.Params.List) > 0 {
		for _, nm := range lit.Type.Params.List[0].Names {
			if obj := sc.pkg.TypesInfo.Defs[nm]; obj != nil {
				child.routers[obj] = true
			}
		}
	}
	w.walkStmts(lit.Body.List, child)
}

// maybeRecurse follows register-style calls: an in-module function receiving
// the router as an argument. Constant string args bind to params so mount-base
// prefixes resolve inside the callee.
func (w *routerWalker) maybeRecurse(call *ast.CallExpr, sc *walkScope) {
	routerArgIdx := -1
	for i, arg := range call.Args {
		if w.isRouter(arg, sc) {
			routerArgIdx = i
			break
		}
	}
	if routerArgIdx < 0 {
		// No argument is a router WE TRACK — but if one is router-shaped by type,
		// this is a hand-off the walk cannot follow, and the registrations behind
		// it are invisible. Say so rather than return silently.
		for _, arg := range call.Args {
			if _, shaped := routerShapeOf(sc.pkg.TypesInfo.TypeOf(arg)); !shaped {
				continue
			}
			if rv := w.routerValued(arg, sc); rv.isRouter && rv.opaqueStep != "" {
				w.note(arg, opaqueReason(rv.opaqueStep))
			} else {
				w.note(arg, "a router is handed to this function and the walk did not "+
					"track where it came from, so its registrations are not counted")
			}
			return
		}
		return
	}
	fn := funcFor(call.Fun, sc.pkg.TypesInfo)
	if fn == nil || w.visiting[fn] {
		return
	}
	site, ok := w.a.decls[fn]
	if !ok || site.decl.Body == nil {
		return
	}
	params := flattenParams(site.decl.Type.Params)
	if len(params) != len(call.Args) {
		return // variadic register funcs don't occur in this shape
	}
	child := &walkScope{
		pkg:     site.pkg,
		routers: map[types.Object]bool{},
		prefix:  sc.prefix,
		mw:      append([]MW{}, sc.mw...),
		consts:  map[types.Object]string{},
		// The dialect travels with the ROUTER, not with the function. A register
		// func that takes a *http.ServeMux is registering stdlib patterns even
		// though nothing in its own body constructs anything — and without this
		// its routes came out with the method still glued to the path.
		dialect: sc.dialect,
	}
	for i, param := range params {
		obj := site.pkg.TypesInfo.Defs[param]
		if obj == nil {
			continue
		}
		if i == routerArgIdx || w.isRouter(call.Args[i], sc) {
			child.routers[obj] = true
			continue
		}
		if s, ok := foldString(call.Args[i], sc.pkg.TypesInfo, sc.consts); ok {
			child.consts[obj] = s
		}
	}
	w.visiting[fn] = true
	w.walkStmts(site.decl.Body.List, child)
	delete(w.visiting, fn)
}

func flattenParams(fields *ast.FieldList) []*ast.Ident {
	if fields == nil {
		return nil
	}
	var out []*ast.Ident
	for _, f := range fields.List {
		out = append(out, f.Names...)
	}
	return out
}

func (w *routerWalker) mwLabels(args []ast.Expr, sc *walkScope) []MW {
	var out []MW
	for _, arg := range args {
		file, line, _ := w.a.relPos(arg.Pos())
		out = append(out, MW{Label: exprLabel(arg), File: file, Line: line})
	}
	return out
}

// joinPath concatenates chi prefixes: Route("/api") + Get("/nodes") →
// /api/nodes; Get("/") under a prefix collapses to the prefix itself.
func joinPath(prefix, p string) string {
	if p == "" || p == "/" {
		if prefix == "" {
			return "/"
		}
		return prefix
	}
	full := prefix + p
	full = strings.ReplaceAll(full, "//", "/")
	if len(full) > 1 {
		full = strings.TrimSuffix(full, "/")
	}
	return full
}
