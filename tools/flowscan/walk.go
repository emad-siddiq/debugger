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
	"go/types"
	"strings"

	"golang.org/x/tools/go/packages"
)

type terminal struct {
	method      string
	path        string
	handlerExpr ast.Expr
	pkg         *packages.Package
	mw          []MW
}

type routerWalker struct {
	a         *analyzer
	terminals []*terminal
	visiting  map[*types.Func]bool
}

type walkScope struct {
	pkg     *packages.Package
	routers map[types.Object]bool
	prefix  string
	mw      []MW
	consts  map[types.Object]string
}

var verbMethods = map[string]string{
	"Get": "GET", "Post": "POST", "Put": "PUT", "Patch": "PATCH",
	"Delete": "DELETE", "Head": "HEAD", "Options": "OPTIONS",
	"Handle": "*", "HandleFunc": "*",
}

func discoverTerminals(a *analyzer) []*terminal {
	w := &routerWalker{a: a, visiting: map[*types.Func]bool{}}
	for _, site := range a.decls {
		if site.decl.Body == nil || !callsNewRouter(site.decl.Body) {
			continue
		}
		sc := &walkScope{
			pkg:     site.pkg,
			routers: map[types.Object]bool{},
			consts:  map[types.Object]string{},
		}
		w.walkStmts(site.decl.Body.List, sc)
	}
	return w.terminals
}

func callsNewRouter(body *ast.BlockStmt) bool {
	found := false
	ast.Inspect(body, func(n ast.Node) bool {
		if call, ok := n.(*ast.CallExpr); ok && isNewRouterCall(call) {
			found = true
		}
		return !found
	})
	return found
}

func isNewRouterCall(call *ast.CallExpr) bool {
	switch f := call.Fun.(type) {
	case *ast.SelectorExpr:
		return f.Sel.Name == "NewRouter" || f.Sel.Name == "NewMux"
	case *ast.Ident:
		return f.Name == "NewRouter" || f.Name == "NewMux"
	}
	return false
}

// walkStmts processes statements in order — chi requires Use before
// registrations in a scope, so sequential accumulation matches semantics.
func (w *routerWalker) walkStmts(stmts []ast.Stmt, sc *walkScope) {
	for _, stmt := range stmts {
		switch s := stmt.(type) {
		case *ast.AssignStmt:
			for i, rhs := range s.Rhs {
				if call, ok := rhs.(*ast.CallExpr); ok && isNewRouterCall(call) && i < len(s.Lhs) {
					if id, ok := s.Lhs[i].(*ast.Ident); ok {
						if obj := sc.pkg.TypesInfo.Defs[id]; obj != nil {
							sc.routers[obj] = true
						} else if obj := sc.pkg.TypesInfo.Uses[id]; obj != nil {
							sc.routers[obj] = true
						}
					}
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
	}
	// Call to an in-module function that receives the router → recurse.
	w.maybeRecurse(call, sc)
}

func (w *routerWalker) isRouter(expr ast.Expr, sc *walkScope) bool {
	id, ok := expr.(*ast.Ident)
	if !ok {
		return false
	}
	obj := sc.pkg.TypesInfo.Uses[id]
	return obj != nil && sc.routers[obj]
}

func (w *routerWalker) handleRouterMethod(name string, call *ast.CallExpr, sc *walkScope) {
	switch {
	case verbMethods[name] != "" && len(call.Args) >= 2:
		w.record(verbMethods[name], call.Args[0], call.Args[1], sc)
	case (name == "Method" || name == "MethodFunc") && len(call.Args) >= 3:
		method, _ := foldString(call.Args[0], sc.pkg.TypesInfo, sc.consts)
		w.record(strings.ToUpper(method), call.Args[1], call.Args[2], sc)
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
		w.record("*", call.Args[0], call.Args[1], sc)
	}
}

func (w *routerWalker) record(method string, pathExpr, handler ast.Expr, sc *walkScope) {
	p, ok := foldString(pathExpr, sc.pkg.TypesInfo, sc.consts)
	if !ok {
		p = "⟨dyn⟩"
	}
	w.terminals = append(w.terminals, &terminal{
		method:      method,
		path:        joinPath(sc.prefix, p),
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
