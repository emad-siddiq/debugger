// godecls — a throwaway companion to plan.js.
//
// plan.js needs four things it cannot get from flows.json and cannot compute in
// Node without a Go type checker:
//
//  1. The SPAN of every top-level declaration, so a "symbol" step can be sized
//     in lines and so a node whose line falls inside an already-written
//     declaration can be recognised as already written.
//  2. The package-level objects each declaration REFERENCES, resolved to the
//     file and line that declares them, so a curriculum can compute the
//     transitive closure of what a handler needs.
//  3. The IMPORT PATHS each declaration requires, with the local name the
//     reference site actually uses, so a file assembled from a subset of its
//     declarations can be given a correct import block (R11).
//  4. The references made ON A GIVEN LINE, because a route registration and a
//     middleware mount are single accreted lines rather than declarations, and
//     they too pull things into the closure (R12 — middleware is not special
//     cased; it arrives because a written line names it).
//
// It writes decls.json and never touches the project it reads.
//
// Usage: godecls --backend <dir> --out decls.json
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/tools/go/packages"
)

// Decl is one top-level declaration: a func, method, type, var or const.
type Decl struct {
	File  string `json:"file"`           // backend-relative
	Name  string `json:"name"`           // bare name; see Recv for methods
	Recv  string `json:"recv,omitempty"` // receiver type, methods only
	Kind  string `json:"kind"`           // func | method | type | var | const
	Start int    `json:"line"`           // 1-based, inclusive (doc comment excluded)
	End   int    `json:"endLine"`        // 1-based, inclusive
	SigTo int    `json:"sigEnd"`         // last line of the signature (the `{` line)
	Pkg   string `json:"pkg"`            // import path
}

// Ref is one package-level object a declaration (or a line) uses.
type Ref struct {
	Name string `json:"name"`
	File string `json:"file,omitempty"` // backend-relative, "" when external
	Line int    `json:"line,omitempty"`
	Pkg  string `json:"pkg"` // import path of the declaring package
	Ext  bool   `json:"ext"` // outside the module (stdlib or third party)
}

// Imp is one import a declaration requires, with the local name its references
// use — `chimw "github.com/go-chi/chi/v5/middleware"` is not interchangeable
// with the same path unaliased, and two packages in one file can both be called
// `middleware`.
type Imp struct {
	Path  string `json:"path"`
	Local string `json:"local"`           // the identifier used at the reference site
	Alias bool   `json:"alias,omitempty"` // the file spells it with an explicit alias
}

// Cycle is one strongly-connected component of >1 declaration in the
// declaration reference graph.
type Cycle struct {
	Pkg   string   `json:"pkg"`
	Size  int      `json:"size"`
	Decls []string `json:"decls"` // "file:line"
}

type Out struct {
	Module   string              `json:"module"`
	Decls    []Decl              `json:"decls"`
	Refs     map[string][]Ref    `json:"refs"`     // "file:line" (decl start) -> refs
	Imports  map[string][]Imp    `json:"imports"`  // "file:line" (decl start) -> imports
	LineRefs map[string][]Ref    `json:"lineRefs"` // "file:line" (any line) -> refs made there
	Blank    map[string][]string `json:"blank"`    // file -> blank/underscore imports
	FileImps map[string][]Imp    `json:"fileImps"` // file -> every import it declares
	Cycles   []Cycle             `json:"cycles"`
	Errors   int                 `json:"loadErrors"`
}

func main() {
	backend := flag.String("backend", "", "backend module directory (required)")
	out := flag.String("out", "decls.json", "output file")
	flag.Parse()
	if *backend == "" {
		flag.Usage()
		os.Exit(2)
	}
	abs, err := filepath.Abs(*backend)
	if err != nil {
		fmt.Fprintln(os.Stderr, "godecls:", err)
		os.Exit(1)
	}

	fset := token.NewFileSet()
	cfg := &packages.Config{
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedSyntax |
			packages.NeedTypes | packages.NeedTypesInfo | packages.NeedImports | packages.NeedDeps,
		Dir:  abs,
		Fset: fset,
	}
	pkgs, err := packages.Load(cfg, "./...")
	if err != nil {
		fmt.Fprintln(os.Stderr, "godecls:", err)
		os.Exit(1)
	}
	nerr := 0
	for _, p := range pkgs {
		nerr += len(p.Errors)
	}

	module := ""
	if raw, err := os.ReadFile(filepath.Join(abs, "go.mod")); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			if strings.HasPrefix(line, "module ") {
				module = strings.TrimSpace(strings.TrimPrefix(line, "module "))
				break
			}
		}
	}

	rel := func(pos token.Pos) (string, int) {
		if !pos.IsValid() {
			return "", 0
		}
		p := fset.Position(pos)
		r, err := filepath.Rel(abs, p.Filename)
		if err != nil || strings.HasPrefix(r, "..") {
			return "", p.Line // outside the module
		}
		return filepath.ToSlash(r), p.Line
	}

	doc := Out{
		Module: module, Refs: map[string][]Ref{}, Imports: map[string][]Imp{},
		LineRefs: map[string][]Ref{}, Blank: map[string][]string{},
		FileImps: map[string][]Imp{}, Errors: nerr,
	}
	seen := map[string]bool{}

	// Pass 1 — per-file import spelling, so a declaration's import set can carry
	// the local name the reference site actually uses.
	aliasOf := map[string]map[string]Imp{} // file -> import path -> Imp
	for _, p := range pkgs {
		for _, f := range p.Syntax {
			file, _ := rel(f.Pos())
			if file == "" || seen[file+"#imports"] {
				continue
			}
			seen[file+"#imports"] = true
			aliasOf[file] = map[string]Imp{}
			for _, spec := range f.Imports {
				path := strings.Trim(spec.Path.Value, `"`)
				if spec.Name != nil && spec.Name.Name == "_" {
					doc.Blank[file] = append(doc.Blank[file], path)
					continue
				}
				imp := Imp{Path: path}
				if spec.Name != nil {
					imp.Local, imp.Alias = spec.Name.Name, true
				} else if ip := p.Types.Imports(); true {
					// The package's real name, which is not always the last path
					// segment (`chi/v5` is package `chi`).
					for _, dep := range ip {
						if dep.Path() == path {
							imp.Local = dep.Name()
							break
						}
					}
					if imp.Local == "" {
						segs := strings.Split(path, "/")
						imp.Local = segs[len(segs)-1]
					}
				}
				aliasOf[file][path] = imp
				doc.FileImps[file] = append(doc.FileImps[file], imp)
			}
		}
	}

	// Pass 2 — declarations, their refs, their imports, and per-line refs.
	for _, p := range pkgs {
		if p.TypesInfo == nil {
			continue
		}
		for _, f := range p.Syntax {
			file, _ := rel(f.Pos())
			if file == "" {
				continue
			}
			collectLineRefs(f, p, rel, doc.LineRefs)
			for _, d := range f.Decls {
				_, start := rel(d.Pos())
				_, end := rel(d.End())
				key := fmt.Sprintf("%s:%d", file, start)
				var decl Decl
				switch g := d.(type) {
				case *ast.FuncDecl:
					decl = Decl{File: file, Name: g.Name.Name, Kind: "func", Start: start, End: end, Pkg: p.PkgPath}
					if g.Recv != nil && len(g.Recv.List) > 0 {
						decl.Kind = "method"
						decl.Recv = types.ExprString(g.Recv.List[0].Type)
					}
					_, decl.SigTo = rel(g.Type.End())
				case *ast.GenDecl:
					if g.Tok == token.IMPORT {
						continue
					}
					decl = Decl{File: file, Kind: g.Tok.String(), Start: start, End: end, SigTo: start, Pkg: p.PkgPath}
					for _, spec := range g.Specs {
						switch s := spec.(type) {
						case *ast.TypeSpec:
							decl.Name = s.Name.Name
						case *ast.ValueSpec:
							if len(s.Names) > 0 {
								decl.Name = s.Names[0].Name
							}
						}
						if decl.Name != "" {
							break
						}
					}
				default:
					continue
				}
				if seen[key] {
					continue
				}
				seen[key] = true
				doc.Decls = append(doc.Decls, decl)
				refs := refsOf(d, p, rel)
				doc.Refs[key] = refs
				doc.Imports[key] = importsFor(refs, p.PkgPath, aliasOf[file])
			}
		}
	}

	sort.Slice(doc.Decls, func(i, j int) bool {
		if doc.Decls[i].File != doc.Decls[j].File {
			return doc.Decls[i].File < doc.Decls[j].File
		}
		return doc.Decls[i].Start < doc.Decls[j].Start
	})
	doc.Cycles = findCycles(doc)

	enc, err := json.MarshalIndent(doc, "", " ")
	if err != nil {
		fmt.Fprintln(os.Stderr, "godecls:", err)
		os.Exit(1)
	}
	if err := os.WriteFile(*out, append(enc, '\n'), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "godecls:", err)
		os.Exit(1)
	}
	withImports := 0
	for _, imps := range doc.Imports {
		if len(imps) > 0 {
			withImports++
		}
	}
	fmt.Fprintf(os.Stderr, "godecls: %d decls (%d with imports), %d files, %d cycles, %d load error(s) → %s\n",
		len(doc.Decls), withImports, len(doc.FileImps), len(doc.Cycles), nerr, *out)
}

// refsOf collects every package-level object the node uses, deduped. Locals,
// parameters and struct fields are skipped: they cannot be a missing dependency.
func refsOf(d ast.Node, p *packages.Package, rel func(token.Pos) (string, int)) []Ref {
	seen := map[string]bool{}
	var out []Ref
	ast.Inspect(d, func(n ast.Node) bool {
		id, ok := n.(*ast.Ident)
		if !ok {
			return true
		}
		if r, ok := refOf(id, p, rel); ok && !seen[r.Pkg+"."+r.Name] {
			seen[r.Pkg+"."+r.Name] = true
			out = append(out, r)
		}
		return true
	})
	sortRefs(out)
	return out
}

func refOf(id *ast.Ident, p *packages.Package, rel func(token.Pos) (string, int)) (Ref, bool) {
	obj := p.TypesInfo.Uses[id]
	if obj == nil || obj.Pkg() == nil {
		return Ref{}, false // builtin, or a definition rather than a use
	}
	if obj.Parent() != obj.Pkg().Scope() {
		// A local, a parameter, or a struct field. Methods have no parent
		// scope, so they survive this test deliberately.
		if _, isFunc := obj.(*types.Func); !isFunc {
			return Ref{}, false
		}
	}
	file, line := rel(obj.Pos())
	return Ref{Name: obj.Name(), File: file, Line: line, Pkg: obj.Pkg().Path(), Ext: file == ""}, true
}

// collectLineRefs records, for every source line, the package-level objects
// referenced on it. A route registration and a middleware mount are lines, not
// declarations, and they still pull things into the closure.
func collectLineRefs(f *ast.File, p *packages.Package, rel func(token.Pos) (string, int), into map[string][]Ref) {
	perLine := map[string]map[string]bool{}
	ast.Inspect(f, func(n ast.Node) bool {
		id, ok := n.(*ast.Ident)
		if !ok {
			return true
		}
		r, ok := refOf(id, p, rel)
		if !ok {
			return true
		}
		file, line := rel(id.Pos())
		if file == "" {
			return true
		}
		key := fmt.Sprintf("%s:%d", file, line)
		if perLine[key] == nil {
			perLine[key] = map[string]bool{}
		}
		if perLine[key][r.Pkg+"."+r.Name] {
			return true
		}
		perLine[key][r.Pkg+"."+r.Name] = true
		into[key] = append(into[key], r)
		return true
	})
	for k := range into {
		sortRefs(into[k])
	}
}

// importsFor turns a declaration's refs into the import set it needs, dropping
// same-package references (which need no import) and carrying the local name.
func importsFor(refs []Ref, ownPkg string, alias map[string]Imp) []Imp {
	seen := map[string]bool{}
	var out []Imp
	for _, r := range refs {
		if r.Pkg == ownPkg || seen[r.Pkg] {
			continue
		}
		seen[r.Pkg] = true
		if imp, ok := alias[r.Pkg]; ok {
			out = append(out, imp)
			continue
		}
		segs := strings.Split(r.Pkg, "/")
		out = append(out, Imp{Path: r.Pkg, Local: segs[len(segs)-1]})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// findCycles reports strongly-connected components of size > 1 in the
// declaration reference graph, restricted to references inside the module.
// Go does not care about declaration order within a package, so a cycle is
// legal — but a closure walk without a visited set will not terminate on one.
func findCycles(doc Out) []Cycle {
	key := func(d Decl) string { return fmt.Sprintf("%s:%d", d.File, d.Start) }
	pkgOf := map[string]string{}
	// A ref lands on the identifier's line, which is the declaration's start for
	// funcs/types but can be an inner line of a grouped var/const block.
	byFile := map[string][]Decl{}
	for _, d := range doc.Decls {
		byFile[d.File] = append(byFile[d.File], d)
		pkgOf[key(d)] = d.Pkg
	}
	owner := func(file string, line int) (string, bool) {
		var best Decl
		found := false
		for _, d := range byFile[file] {
			if d.Start <= line && line <= d.End {
				best, found = d, true
			}
		}
		if !found {
			return "", false
		}
		return key(best), true
	}
	adj := map[string][]string{}
	for k, refs := range doc.Refs {
		for _, r := range refs {
			if r.Ext || r.File == "" {
				continue
			}
			if o, ok := owner(r.File, r.Line); ok && o != k {
				adj[k] = append(adj[k], o)
			}
		}
	}

	// Tarjan.
	index := map[string]int{}
	low := map[string]int{}
	onStack := map[string]bool{}
	var stack []string
	next := 0
	var out []Cycle
	var strongconnect func(v string)
	strongconnect = func(v string) {
		index[v], low[v] = next, next
		next++
		stack = append(stack, v)
		onStack[v] = true
		for _, w := range adj[v] {
			if _, ok := index[w]; !ok {
				strongconnect(w)
				if low[w] < low[v] {
					low[v] = low[w]
				}
			} else if onStack[w] && index[w] < low[v] {
				low[v] = index[w]
			}
		}
		if low[v] == index[v] {
			var comp []string
			for {
				w := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				onStack[w] = false
				comp = append(comp, w)
				if w == v {
					break
				}
			}
			if len(comp) > 1 {
				sort.Strings(comp)
				out = append(out, Cycle{Pkg: pkgOf[comp[0]], Size: len(comp), Decls: comp})
			}
		}
	}
	for k := range adj {
		if _, ok := index[k]; !ok {
			strongconnect(k)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Size > out[j].Size })
	return out
}

func sortRefs(rs []Ref) {
	sort.Slice(rs, func(i, j int) bool {
		if rs[i].Pkg != rs[j].Pkg {
			return rs[i].Pkg < rs[j].Pkg
		}
		return rs[i].Name < rs[j].Name
	})
}
