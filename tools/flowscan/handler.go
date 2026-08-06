// handler.go — build one Flow per discovered registration: resolve the handler
// expression, walk its body for querier calls, follow store-interface calls to
// their concrete implementations, and prune hops that never reach SQL.
package main

import (
	"go/ast"
	"go/token"
	"go/types"

	"golang.org/x/tools/go/packages"
)

const maxDepth = 4
const maxSQLLen = 1200

type flowBuilder struct {
	a          *analyzer
	flow       *Flow
	visitStack map[*types.Func]bool
}

func buildFlow(a *analyzer, term *terminal) *Flow {
	file, line, _ := a.relPos(term.handlerExpr.Pos())
	flow := &Flow{
		Method:     term.method,
		Path:       term.path,
		File:       file,
		Line:       line,
		Middleware: term.mw,
	}
	b := &flowBuilder{a: a, flow: flow, visitStack: map[*types.Func]bool{}}
	b.resolveHandler(term.handlerExpr, term.pkg, 0)
	b.prune()
	b.attachTables()
	b.status()
	return flow
}

// addNode appends a node and, when it has a parent, the edge that reaches it.
//
// `rel` and `at` are what the parent DOES to the child and WHERE it does it —
// both known at every call site here, and both dropped on the floor until now.
// `at` is the call site rather than the child's declaration: they are usually
// in different files, and it is the call site a reader is looking for.
// A root node (parent < 0) has no edge, so rel and at are ignored.
func (b *flowBuilder) addNode(n *Node, parent int, rel string, at token.Pos) int {
	b.flow.Nodes = append(b.flow.Nodes, n)
	idx := len(b.flow.Nodes) - 1
	if parent >= 0 {
		b.flow.Edges = append(b.flow.Edges, b.edge(parent, idx, rel, at))
	}
	return idx
}

func (b *flowBuilder) edge(from, to int, rel string, at token.Pos) Edge {
	file, line, col := b.a.relPos(at)
	return Edge{From: from, To: to, Rel: rel, File: file, Line: line, Col: col}
}

// resolveHandler turns the registration's handler expression into the flow's
// handler node and kicks off body analysis. unwraps counts wrapper middleware
// like mw(realHandler(...)) — capped so odd shapes can't loop.
func (b *flowBuilder) resolveHandler(expr ast.Expr, pkg *packages.Package, unwraps int) {
	switch e := expr.(type) {
	case *ast.CallExpr:
		fn := funcFor(e.Fun, pkg.TypesInfo)
		if fn == nil {
			b.addNode(&Node{Kind: "unknown", Label: exprLabel(expr), Reason: "handler expression did not resolve to a function"}, -1, "", token.NoPos)
			return
		}
		site, ok := b.a.decls[fn]
		if !ok {
			b.addNode(&Node{Kind: "unknown", Label: funcLabel(fn), Reason: "handler declared outside the analyzed module"}, -1, "", token.NoPos)
			return
		}
		if lit := returnedFuncLit(site.decl); lit != nil {
			bindings := bindArgs(site.decl, e, pkg, site.pkg)
			hIdx := b.handlerNode(fn, site)
			b.analyzeBody(lit, site.pkg, bindings, hIdx, 1)
			return
		}
		// No returned closure: maybe a wrapper — mw(realHandler(...)).
		if unwraps < 3 {
			for _, arg := range e.Args {
				inner, isCall := arg.(*ast.CallExpr)
				if !isCall {
					continue
				}
				if innerFn := funcFor(inner.Fun, pkg.TypesInfo); innerFn != nil {
					if innerSite, ok := b.a.decls[innerFn]; ok && returnedFuncLit(innerSite.decl) != nil {
						b.flow.Middleware = append(b.flow.Middleware, MW{Label: funcLabel(fn)})
						b.resolveHandler(inner, pkg, unwraps+1)
						return
					}
				}
			}
		}
		// Constructor without a recognizable closure: analyze its whole body.
		bindings := bindArgs(site.decl, e, pkg, site.pkg)
		hIdx := b.handlerNode(fn, site)
		b.analyzeBody(site.decl.Body, site.pkg, bindings, hIdx, 1)
	case *ast.Ident, *ast.SelectorExpr:
		fn := funcFor(e, pkg.TypesInfo)
		if fn == nil {
			// Method value like a.CapacityChecker.DebugDiskPressure resolves
			// through Selections; funcFor covers it — reaching here means an
			// http.Handler var or similar.
			b.addNode(&Node{Kind: "unknown", Label: exprLabel(expr), Reason: "handler is not a statically resolvable function"}, -1, "", token.NoPos)
			return
		}
		site, ok := b.a.decls[fn]
		if !ok {
			b.addNode(&Node{Kind: "unknown", Label: funcLabel(fn), Reason: "handler declared outside the analyzed module"}, -1, "", token.NoPos)
			return
		}
		hIdx := b.handlerNode(fn, site)
		if site.decl.Body != nil {
			b.analyzeBody(site.decl.Body, site.pkg, map[types.Object]types.Type{}, hIdx, 1)
		}
	case *ast.FuncLit:
		hIdx := b.addNode(&Node{Kind: "handler", Label: "inline handler"}, -1, "", token.NoPos)
		if file, line, col := b.a.relPos(e.Pos()); file != "" {
			b.flow.Nodes[hIdx].File, b.flow.Nodes[hIdx].Line, b.flow.Nodes[hIdx].Col = file, line, col
		}
		b.analyzeBody(e, pkg, map[types.Object]types.Type{}, hIdx, 1)
	default:
		b.addNode(&Node{Kind: "unknown", Label: exprLabel(expr), Reason: "unrecognized handler expression shape"}, -1, "", token.NoPos)
	}
}

func (b *flowBuilder) handlerNode(fn *types.Func, site declSite) int {
	file, line, col := b.a.relPos(site.decl.Name.Pos())
	return b.addNode(&Node{Kind: "handler", Label: funcLabel(fn), File: file, Line: line, Col: col}, -1, "", token.NoPos)
}

// bindArgs maps the callee's interface-typed parameters to the concrete types
// of the call-site arguments (the store-injection seam: the router passes
// *PgxValidatorStore where the handler takes validatorStore).
func bindArgs(decl *ast.FuncDecl, call *ast.CallExpr, callerPkg, calleePkg *packages.Package) map[types.Object]types.Type {
	bindings := map[types.Object]types.Type{}
	params := flattenParams(decl.Type.Params)
	if len(params) != len(call.Args) {
		return bindings
	}
	for i, param := range params {
		obj := calleePkg.TypesInfo.Defs[param]
		if obj == nil {
			continue
		}
		if !types.IsInterface(obj.Type()) {
			continue
		}
		if tv, ok := callerPkg.TypesInfo.Types[call.Args[i]]; ok && tv.Type != nil && !types.IsInterface(tv.Type) {
			bindings[obj] = tv.Type
		}
	}
	return bindings
}

// analyzeBody walks a function/closure body collecting querier calls and
// following store-method hops. Everything found attaches under parentIdx.
func (b *flowBuilder) analyzeBody(body ast.Node, pkg *packages.Package, bindings map[types.Object]types.Type, parentIdx, depth int) {
	ast.Inspect(body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if sqlExpr := sqlArgOf(call, pkg.TypesInfo); sqlExpr != nil {
			sql, complete := foldString(sqlExpr, pkg.TypesInfo, nil)
			sql = squishSQL(sql)
			if len(sql) > maxSQLLen {
				sql = sql[:maxSQLLen] + " …"
			}
			file, line, col := b.a.relPos(call.Pos())
			b.addNode(&Node{
				Kind: "query", Label: firstWord(sql),
				File: file, Line: line, Col: col,
				SQL: sql, SQLKind: sqlKind(sql),
				Tables:  extractTables(sql, b.a.knownTables),
				Partial: !complete,
			}, parentIdx, RelExecutes, call.Pos())
			return true
		}
		b.followCall(call, pkg, bindings, parentIdx, depth)
		return true
	})
}

// followCall resolves a non-querier call and recurses when it can lead to SQL:
// interface-store methods resolve to their concrete implementation (visible
// "store" hop); plain in-module helpers flatten into the current parent.
func (b *flowBuilder) followCall(call *ast.CallExpr, pkg *packages.Package, bindings map[types.Object]types.Type, parentIdx, depth int) {
	if depth > maxDepth {
		return
	}
	sel, isSel := call.Fun.(*ast.SelectorExpr)
	if isSel {
		if tv, ok := pkg.TypesInfo.Types[sel.X]; ok && tv.Type != nil && types.IsInterface(tv.Type) {
			b.followInterfaceCall(call, sel, tv.Type, pkg, bindings, parentIdx, depth)
			return
		}
	}
	fn := funcFor(call.Fun, pkg.TypesInfo)
	if fn == nil || b.visitStack[fn] {
		return
	}
	site, ok := b.a.decls[fn]
	if !ok || site.decl.Body == nil {
		return
	}
	if !b.a.sqlPkgs[fn.Pkg()] {
		return // callee's package touches no SQL; nothing to find below
	}
	childBindings := mergeBindings(bindings, bindArgs(site.decl, call, pkg, site.pkg))
	b.visitStack[fn] = true
	if isSel && fn.Signature().Recv() != nil {
		// Method on a concrete type (store method called directly): visible hop.
		file, line, col := b.a.relPos(site.decl.Name.Pos())
		idx := b.addNode(&Node{Kind: "store", Label: funcLabel(fn), File: file, Line: line, Col: col}, parentIdx, RelCalls, call.Pos())
		b.analyzeBody(site.decl.Body, site.pkg, childBindings, idx, depth+1)
	} else {
		// Plain helper: flatten — its queries attach to the current parent.
		b.analyzeBody(site.decl.Body, site.pkg, childBindings, parentIdx, depth+1)
	}
	delete(b.visitStack, fn)
}

func (b *flowBuilder) followInterfaceCall(call *ast.CallExpr, sel *ast.SelectorExpr, ifaceType types.Type, pkg *packages.Package, bindings map[types.Object]types.Type, parentIdx, depth int) {
	iface, _ := ifaceType.Underlying().(*types.Interface)
	if iface == nil || iface.NumMethods() == 0 {
		return
	}
	// Store seams are named interfaces declared in the analyzed module
	// (validatorStore, NodeShareStore, …). Anything else — context.Context,
	// pgx.Rows, anonymous scanner interfaces — is plumbing, not a data hop.
	if !b.a.inModuleNamedIface(ifaceType) {
		return
	}
	var concrete types.Type
	if id, ok := sel.X.(*ast.Ident); ok {
		if obj := pkg.TypesInfo.Uses[id]; obj != nil {
			if bound, ok := bindings[obj]; ok {
				concrete = bound
			}
		}
	}
	if concrete == nil {
		concrete = b.a.uniqueImpl(iface)
	}
	if concrete == nil {
		b.addNode(&Node{
			Kind: "unknown", Label: exprLabel(sel),
			Reason: "interface " + ifaceType.String() + ": implementation not statically resolvable",
		}, parentIdx, RelUnresolved, sel.Pos())
		return
	}
	obj, _, _ := types.LookupFieldOrMethod(concrete, true, pkg.Types, sel.Sel.Name)
	method, _ := obj.(*types.Func)
	if method == nil {
		b.addNode(&Node{Kind: "unknown", Label: exprLabel(sel), Reason: "method " + sel.Sel.Name + " not found on " + concrete.String()}, parentIdx, RelUnresolved, sel.Pos())
		return
	}
	site, ok := b.a.decls[method]
	if !ok || site.decl.Body == nil || b.visitStack[method] {
		return
	}
	file, line, col := b.a.relPos(site.decl.Name.Pos())
	idx := b.addNode(&Node{Kind: "store", Label: funcLabel(method), File: file, Line: line, Col: col}, parentIdx, RelCalls, call.Pos())
	childBindings := mergeBindings(bindings, bindArgs(site.decl, call, pkg, site.pkg))
	b.visitStack[method] = true
	b.analyzeBody(site.decl.Body, site.pkg, childBindings, idx, depth+1)
	delete(b.visitStack, method)
}

// inModuleNamedIface reports whether t is a named interface declared inside
// the analyzed module — the shape of a store seam.
func (a *analyzer) inModuleNamedIface(t types.Type) bool {
	named, ok := types.Unalias(t).(*types.Named)
	if !ok || named.Obj().Pkg() == nil {
		return false
	}
	_, inModule := a.sqlPkgs[named.Obj().Pkg()]
	return inModule
}

// uniqueImpl finds the single in-module concrete type implementing iface, or
// nil when there are zero or several.
func (a *analyzer) uniqueImpl(iface *types.Interface) types.Type {
	var found types.Type
	count := 0
	for _, p := range a.pkgs {
		if p.Types == nil {
			continue
		}
		scope := p.Types.Scope()
		for _, name := range scope.Names() {
			tn, ok := scope.Lookup(name).(*types.TypeName)
			if !ok || tn.IsAlias() {
				continue
			}
			named := tn.Type()
			if types.IsInterface(named) {
				continue
			}
			ptr := types.NewPointer(named)
			switch {
			case types.Implements(ptr, iface):
				found = ptr
				count++
			case types.Implements(named, iface):
				found = named
				count++
			}
		}
	}
	if count == 1 {
		return found
	}
	return nil
}

func mergeBindings(a, b map[types.Object]types.Type) map[types.Object]types.Type {
	if len(b) == 0 {
		return a
	}
	out := make(map[types.Object]types.Type, len(a)+len(b))
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}

func funcLabel(fn *types.Func) string {
	if recv := fn.Signature().Recv(); recv != nil {
		t := recv.Type()
		if ptr, ok := t.(*types.Pointer); ok {
			t = ptr.Elem()
		}
		if named, ok := t.(*types.Named); ok {
			return named.Obj().Name() + "." + fn.Name()
		}
	}
	if fn.Pkg() != nil {
		return fn.Pkg().Name() + "." + fn.Name()
	}
	return fn.Name()
}

// prune drops store hops whose subtree never reached SQL or an unknown —
// helper chatter that would clutter the diagram.
func (b *flowBuilder) prune() {
	nodes, edges := b.flow.Nodes, b.flow.Edges
	children := map[int][]int{}
	for _, e := range edges {
		children[e.From] = append(children[e.From], e.To)
	}
	keep := make([]bool, len(nodes))
	var mark func(i int) bool
	mark = func(i int) bool {
		kept := nodes[i].Kind == "query" || nodes[i].Kind == "unknown" || nodes[i].Kind == "handler"
		for _, c := range children[i] {
			if mark(c) {
				kept = true
			}
		}
		keep[i] = kept
		return kept
	}
	for i, n := range nodes {
		if n.Kind == "handler" || !hasParent(edges, i) {
			mark(i)
		}
	}
	remap := make([]int, len(nodes))
	var outNodes []*Node
	for i, n := range nodes {
		if keep[i] {
			remap[i] = len(outNodes)
			outNodes = append(outNodes, n)
		} else {
			remap[i] = -1
		}
	}
	var outEdges []Edge
	for _, e := range edges {
		if remap[e.From] >= 0 && remap[e.To] >= 0 {
			e.From, e.To = remap[e.From], remap[e.To]
			outEdges = append(outEdges, e)
		}
	}
	b.flow.Nodes, b.flow.Edges = outNodes, outEdges
}

func hasParent(edges []Edge, i int) bool {
	for _, e := range edges {
		if e.To == i {
			return true
		}
	}
	return false
}

// attachTables adds one table node per distinct table, linked from each query
// node that touches it, and fills Flow.Tables.
//
// The edge verb is PER TABLE, re-derived from the statement rather than taken
// from Node.SQLKind, which is one verdict for the whole statement:
// `INSERT INTO audit SELECT … FROM users` writes one table and reads the other,
// and drawing both edges the same way is simply wrong. SQLKind stays as the
// box's badge — it describes the statement, this describes one table.
func (b *flowBuilder) attachTables() {
	tableIdx := map[string]int{}
	for i, n := range b.flow.Nodes {
		if n.Kind != "query" {
			continue
		}
		writes := map[string]bool{}
		for _, ref := range tableRefs(n.SQL, b.a.knownTables) {
			writes[ref.Name] = ref.Write
		}
		// n.Tables is the sorted, deduplicated list, so edge order is stable.
		for _, table := range n.Tables {
			idx, ok := tableIdx[table]
			if !ok {
				file, line := "", 0
				if mig, ok := b.a.knownTables[table]; ok && mig != "" {
					file = "migrations/" + mig
					line = b.a.tableLine(file, table)
				}
				idx = b.addNode(&Node{Kind: "table", Label: table, File: file, Line: line}, -1, "", token.NoPos)
				tableIdx[table] = idx
				b.flow.Tables = append(b.flow.Tables, table)
			}
			rel := RelReads
			if writes[table] {
				rel = RelWrites
			}
			// The statement is what touches the table, so its position is the
			// line this edge is about.
			b.flow.Edges = append(b.flow.Edges, Edge{From: i, To: idx, Rel: rel, File: n.File, Line: n.Line, Col: n.Col})
		}
	}
}

func (b *flowBuilder) status() {
	hasUnknown, hasPartial, hasHandler := false, false, false
	for _, n := range b.flow.Nodes {
		switch n.Kind {
		case "unknown":
			hasUnknown = true
		case "handler":
			hasHandler = true
		case "query":
			if n.Partial {
				hasPartial = true
			}
		}
	}
	switch {
	case !hasHandler:
		b.flow.Status = "unknown"
	case hasUnknown || hasPartial:
		b.flow.Status = "partial"
	default:
		b.flow.Status = "traced"
	}
}
