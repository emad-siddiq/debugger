// godecls — a throwaway companion to plan.js.
//
// plan.js needs two things it cannot get from flows.json and cannot compute in
// Node without a Go type checker:
//
//  1. The SPAN of every top-level declaration, so a "symbol" step can be sized
//     in lines and so a node whose line falls inside an already-written
//     declaration can be recognised as already written.
//  2. The package-level objects each declaration REFERENCES, resolved to the
//     file and line that declares them, so the curriculum's import closure can
//     be checked act by act.
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

// Decl is one top-level declaration: a func, type, var or const.
type Decl struct {
	File  string `json:"file"`  // backend-relative
	Name  string `json:"name"`  // Recv.Name for methods
	Kind  string `json:"kind"`  // func | method | type | var | const
	Start int    `json:"start"` // 1-based, inclusive (doc comment excluded)
	End   int    `json:"end"`   // 1-based, inclusive
	Pkg   string `json:"pkg"`   // import path
}

// Ref is one package-level object a declaration uses.
type Ref struct {
	Name string `json:"name"`
	File string `json:"file,omitempty"` // backend-relative, "" when external
	Line int    `json:"line,omitempty"`
	Pkg  string `json:"pkg"` // import path of the declaring package
	Ext  bool   `json:"ext"` // outside the module (stdlib or third party)
}

type Out struct {
	Module  string              `json:"module"`
	Decls   []Decl              `json:"decls"`
	Refs    map[string][]Ref    `json:"refs"`    // "file:start" -> refs
	Imports map[string][]string `json:"imports"` // backend-relative file -> import paths
	Errors  int                 `json:"loadErrors"`
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

	doc := Out{Module: module, Refs: map[string][]Ref{}, Imports: map[string][]string{}, Errors: nerr}
	seen := map[string]bool{}

	for _, p := range pkgs {
		if p.TypesInfo == nil {
			continue
		}
		for _, f := range p.Syntax {
			file, _ := rel(f.Pos())
			if file == "" || seen[file+"#imports"] {
				continue
			}
			seen[file+"#imports"] = true
			for _, imp := range f.Imports {
				doc.Imports[file] = append(doc.Imports[file], strings.Trim(imp.Path.Value, `"`))
			}
		}
		for _, f := range p.Syntax {
			for _, d := range f.Decls {
				file, start := rel(d.Pos())
				if file == "" {
					continue
				}
				_, end := rel(d.End())
				key := fmt.Sprintf("%s:%d", file, start)

				switch decl := d.(type) {
				case *ast.FuncDecl:
					kind, name := "func", decl.Name.Name
					if decl.Recv != nil && len(decl.Recv.List) > 0 {
						kind = "method"
						name = types.ExprString(decl.Recv.List[0].Type) + "." + name
					}
					if seen[key] {
						continue
					}
					seen[key] = true
					doc.Decls = append(doc.Decls, Decl{File: file, Name: name, Kind: kind, Start: start, End: end, Pkg: p.PkgPath})
					doc.Refs[key] = refsOf(d, p, rel)
				case *ast.GenDecl:
					kind := decl.Tok.String() // type | var | const | import
					if kind == "import" {
						continue
					}
					name := ""
					for _, spec := range decl.Specs {
						switch s := spec.(type) {
						case *ast.TypeSpec:
							name = s.Name.Name
						case *ast.ValueSpec:
							if len(s.Names) > 0 && name == "" {
								name = s.Names[0].Name
							}
						}
						if name != "" {
							break
						}
					}
					if seen[key] {
						continue
					}
					seen[key] = true
					doc.Decls = append(doc.Decls, Decl{File: file, Name: name, Kind: kind, Start: start, End: end, Pkg: p.PkgPath})
					doc.Refs[key] = refsOf(d, p, rel)
				}
			}
		}
	}

	sort.Slice(doc.Decls, func(i, j int) bool {
		if doc.Decls[i].File != doc.Decls[j].File {
			return doc.Decls[i].File < doc.Decls[j].File
		}
		return doc.Decls[i].Start < doc.Decls[j].Start
	})

	enc, err := json.MarshalIndent(doc, "", " ")
	if err != nil {
		fmt.Fprintln(os.Stderr, "godecls:", err)
		os.Exit(1)
	}
	if err := os.WriteFile(*out, append(enc, '\n'), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "godecls:", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "godecls: %d decls, %d files, %d load error(s) → %s\n",
		len(doc.Decls), len(doc.Imports), nerr, *out)
}

// refsOf collects every package-level object the declaration uses, deduped.
// Locals, fields and labels are skipped: they cannot be a missing dependency.
func refsOf(d ast.Node, p *packages.Package, rel func(token.Pos) (string, int)) []Ref {
	seen := map[string]bool{}
	var out []Ref
	ast.Inspect(d, func(n ast.Node) bool {
		id, ok := n.(*ast.Ident)
		if !ok {
			return true
		}
		obj := p.TypesInfo.Uses[id]
		if obj == nil || obj.Pkg() == nil {
			return true // builtin, or a definition rather than a use
		}
		if obj.Parent() != obj.Pkg().Scope() {
			// A local, a parameter, or a struct field: not a package-level dep.
			// Methods have no parent scope, so keep those.
			if _, isFunc := obj.(*types.Func); !isFunc {
				return true
			}
		}
		file, line := rel(obj.Pos())
		key := obj.Pkg().Path() + "." + obj.Name()
		if seen[key] {
			return true
		}
		seen[key] = true
		out = append(out, Ref{Name: obj.Name(), File: file, Line: line, Pkg: obj.Pkg().Path(), Ext: file == ""})
		return true
	})
	sort.Slice(out, func(i, j int) bool {
		if out[i].Pkg != out[j].Pkg {
			return out[i].Pkg < out[j].Pkg
		}
		return out[i].Name < out[j].Name
	})
	return out
}
