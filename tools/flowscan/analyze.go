// analyze.go — package loading and the shared type/decl indexes the walkers use.
package main

import (
	"fmt"
	"go/ast"
	"go/constant"
	"go/token"
	"go/types"
	"path/filepath"
	"strings"

	"golang.org/x/tools/go/packages"
)

type declSite struct {
	decl *ast.FuncDecl
	pkg  *packages.Package
}

type analyzer struct {
	backendDir  string
	fset        *token.FileSet
	pkgs        []*packages.Package
	decls       map[*types.Func]declSite
	sqlPkgs     map[*types.Package]bool // package contains querier calls (recursion prune)
	knownTables map[string]string
	// migration (backend-relative) -> table -> CREATE TABLE line; see migrations.go.
	migLines map[string]map[string]int
}

func newAnalyzer(backendDir string, knownTables map[string]string) (*analyzer, error) {
	fset := token.NewFileSet()
	cfg := &packages.Config{
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedSyntax |
			packages.NeedTypes | packages.NeedTypesInfo | packages.NeedImports | packages.NeedDeps,
		Dir:  backendDir,
		Fset: fset,
	}
	pkgs, err := packages.Load(cfg, "./...")
	if err != nil {
		return nil, fmt.Errorf("load %s: %w", backendDir, err)
	}
	var loadErrs []string
	for _, p := range pkgs {
		for _, e := range p.Errors {
			loadErrs = append(loadErrs, e.Error())
		}
	}
	if len(pkgs) == 0 {
		return nil, fmt.Errorf("no packages under %s", backendDir)
	}
	if len(loadErrs) > 0 {
		// Type errors degrade analysis but rarely block it; surface and continue.
		fmt.Fprintf(warnw, "flowscan: %d load error(s), first: %s\n", len(loadErrs), loadErrs[0])
	}

	a := &analyzer{
		backendDir:  backendDir,
		fset:        fset,
		pkgs:        pkgs,
		decls:       map[*types.Func]declSite{},
		sqlPkgs:     map[*types.Package]bool{},
		knownTables: knownTables,
	}
	for _, p := range pkgs {
		for _, f := range p.Syntax {
			for _, d := range f.Decls {
				fd, ok := d.(*ast.FuncDecl)
				if !ok || fd.Name == nil {
					continue
				}
				if obj, ok := p.TypesInfo.Defs[fd.Name].(*types.Func); ok {
					a.decls[obj] = declSite{decl: fd, pkg: p}
				}
			}
		}
	}
	for _, p := range pkgs {
		if p.Types != nil {
			a.sqlPkgs[p.Types] = pkgHasQuerierCalls(p)
		}
	}
	return a, nil
}

var querierMethods = map[string]bool{"Query": true, "QueryRow": true, "Exec": true, "SendBatch": true}

// pkgHasQuerierCalls reports whether any file in p calls a Query/QueryRow/Exec/
// SendBatch method with a string-typed argument — the structural signature of
// a data-access package. Used to prune helper recursion.
func pkgHasQuerierCalls(p *packages.Package) bool {
	found := false
	for _, f := range p.Syntax {
		ast.Inspect(f, func(n ast.Node) bool {
			if found {
				return false
			}
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			if sqlArgOf(call, p.TypesInfo) != nil {
				found = true
				return false
			}
			return true
		})
	}
	return found
}

// sqlArgOf returns the SQL string argument when call is a querier method call,
// nil otherwise. Structural: method name Query/QueryRow/Exec/SendBatch, first
// string-typed argument is the statement.
func sqlArgOf(call *ast.CallExpr, info *types.Info) ast.Expr {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || !querierMethods[sel.Sel.Name] {
		return nil
	}
	for _, arg := range call.Args {
		tv, ok := info.Types[arg]
		if !ok || tv.Type == nil {
			continue
		}
		if basic, ok := tv.Type.Underlying().(*types.Basic); ok && basic.Info()&types.IsString != 0 {
			return arg
		}
	}
	return nil
}

// funcFor resolves the *types.Func a call expression targets, if any.
func funcFor(fun ast.Expr, info *types.Info) *types.Func {
	switch e := fun.(type) {
	case *ast.Ident:
		if f, ok := info.Uses[e].(*types.Func); ok {
			return f
		}
	case *ast.SelectorExpr:
		if selInfo, ok := info.Selections[e]; ok {
			if f, ok := selInfo.Obj().(*types.Func); ok {
				return f
			}
			return nil
		}
		// Package-qualified call: pkg.Func
		if f, ok := info.Uses[e.Sel].(*types.Func); ok {
			return f
		}
	case *ast.ParenExpr:
		return funcFor(e.X, info)
	}
	return nil
}

// relPos converts a token.Pos to a backend-relative file path + line/col.
func (a *analyzer) relPos(pos token.Pos) (string, int, int) {
	if !pos.IsValid() {
		return "", 0, 0
	}
	p := a.fset.Position(pos)
	rel, err := filepath.Rel(a.backendDir, p.Filename)
	if err != nil || strings.HasPrefix(rel, "..") {
		rel = p.Filename
	}
	return rel, p.Line, p.Column
}

// foldString best-effort resolves expr to a string. varConsts binds function
// parameters to constant call-site arguments (mount-base params). Incomplete
// parts render as ⟨…⟩ placeholders; complete=false marks them.
func foldString(expr ast.Expr, info *types.Info, varConsts map[types.Object]string) (string, bool) {
	if tv, ok := info.Types[expr]; ok && tv.Value != nil && tv.Value.Kind() == constant.String {
		return constant.StringVal(tv.Value), true
	}
	switch e := expr.(type) {
	case *ast.BinaryExpr:
		if e.Op == token.ADD {
			l, lok := foldString(e.X, info, varConsts)
			r, rok := foldString(e.Y, info, varConsts)
			return l + r, lok && rok
		}
	case *ast.Ident:
		if obj := info.Uses[e]; obj != nil {
			if v, ok := varConsts[obj]; ok {
				return v, true
			}
		}
	case *ast.ParenExpr:
		return foldString(e.X, info, varConsts)
	case *ast.CallExpr:
		// fmt.Sprintf(constFmt, …): the format string is usually the whole
		// statement shape; keep it with verbs left in, flagged incomplete.
		if sel, ok := e.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "Sprintf" && len(e.Args) > 0 {
			if s, _ := foldString(e.Args[0], info, varConsts); s != "" {
				return s, false
			}
		}
	}
	return "⟨dyn⟩", false
}

// exprLabel renders a short human label for a middleware/handler expression.
func exprLabel(expr ast.Expr) string {
	switch e := expr.(type) {
	case *ast.CallExpr:
		return types.ExprString(e.Fun) + "(…)"
	case *ast.SelectorExpr:
		if inner, ok := e.X.(*ast.CallExpr); ok {
			return types.ExprString(inner.Fun) + "(…)." + e.Sel.Name
		}
		return types.ExprString(e)
	default:
		return types.ExprString(e)
	}
}
