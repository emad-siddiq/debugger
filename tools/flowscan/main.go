// flowscan traces a chi-shaped Go backend from route registration down to the
// SQL it runs and the tables it touches, emitting flows.json for burrow-flow.
//
// Usage:
//
//	flowscan --backend <dir> [--digest <digest.md|digest.json>] [--out flows.json] [--filter substr]
//
// The digest (from the target project's oracle) supplies the authoritative
// route catalog to reconcile against plus the known-tables set; without it,
// flowscan still emits every registration it discovers.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"
)

var warnw = os.Stderr

func main() {
	backend := flag.String("backend", "", "backend module directory (required)")
	digestPath := flag.String("digest", "", "oracle digest file (markdown or launcher digest.json)")
	out := flag.String("out", "", "output file (default stdout)")
	filter := flag.String("filter", "", "only emit flows whose path contains this substring")
	flag.Parse()
	if *backend == "" {
		flag.Usage()
		os.Exit(2)
	}

	var digest *Digest
	if *digestPath != "" {
		var err error
		digest, err = loadDigest(*digestPath)
		if err != nil {
			fmt.Fprintf(warnw, "flowscan: digest: %v\n", err)
			os.Exit(1)
		}
	}
	known := map[string]string{}
	if digest != nil {
		known = digest.Tables
	}

	a, err := newAnalyzer(*backend, known)
	if err != nil {
		fmt.Fprintf(warnw, "flowscan: %v\n", err)
		os.Exit(1)
	}

	terminals, unfollowed := discoverRouters(a)
	doc := assembleWith(a, terminals, unfollowed, digest, *filter)
	doc.Backend = *backend
	doc.Rev = gitRev(*backend)
	doc.GeneratedAt = time.Now().UTC().Format(time.RFC3339)

	// A handler that calls no store method has no edges, and a nil Go slice
	// marshals to `null`, not `[]`. The consumer iterates flow.edges directly,
	// so one such route (16 of merkle's 235) threw before it drew anything.
	// Emit the empty list the schema promises.
	for _, f := range doc.Flows {
		if f.Edges == nil {
			f.Edges = []Edge{}
		}
		if f.Nodes == nil {
			f.Nodes = []*Node{}
		}
	}

	enc, err := json.MarshalIndent(doc, "", " ")
	if err != nil {
		fmt.Fprintf(warnw, "flowscan: marshal: %v\n", err)
		os.Exit(1)
	}
	if *out == "" {
		os.Stdout.Write(append(enc, '\n'))
		return
	}
	if err := os.WriteFile(*out, append(enc, '\n'), 0o644); err != nil {
		fmt.Fprintf(warnw, "flowscan: write %s: %v\n", *out, err)
		os.Exit(1)
	}
	if n := len(doc.Coverage.Unfollowed); n > 0 {
		fmt.Fprintf(warnw, "flowscan: %d router(s) recognised but not followed:\n", n)
		for _, u := range doc.Coverage.Unfollowed {
			fmt.Fprintf(warnw, "  %s:%d — %s\n", u.File, u.Line, u.Reason)
		}
	}
	fmt.Fprintf(warnw, "flowscan: %d flows (%d traced, %d partial, %d unknown) → %s\n",
		len(doc.Flows), doc.Coverage.Traced, doc.Coverage.Partial, doc.Coverage.Unknown, *out)
}

// assemble builds flows for every discovered terminal, ordered by the digest
// catalog when present, and computes coverage reconciliation.
func assemble(a *analyzer, terminals []*terminal, digest *Digest, filter string) *Output {
	return assembleWith(a, terminals, nil, digest, filter)
}

// assembleWith is `assemble` plus the routers the walk could not follow. They are
// carried on Coverage rather than folded into a route bucket — see Unfollowed.
func assembleWith(a *analyzer, terminals []*terminal, unfollowed []Unfollowed, digest *Digest, filter string) *Output {
	// Schema 2: edges carry the relation and the call site. Consumers read
	// the old two-integer shape too, so an older cached flows.json still draws.
	doc := &Output{Schema: 2, Tables: a.knownTables}
	doc.Coverage.Unfollowed = unfollowed

	byKey := map[string]*terminal{}
	var order []string
	for _, t := range terminals {
		key := t.method + " " + t.path
		if _, dup := byKey[key]; !dup {
			byKey[key] = t
			order = append(order, key)
		}
	}

	matched := map[string]bool{}
	emit := func(key string, t *terminal) {
		if filter != "" && !strings.Contains(t.path, filter) {
			return
		}
		flow := buildFlow(a, t)
		doc.Flows = append(doc.Flows, flow)
		switch flow.Status {
		case "traced":
			doc.Coverage.Traced++
		case "partial":
			doc.Coverage.Partial++
		default:
			doc.Coverage.Unknown++
		}
		matched[key] = true
	}

	if digest != nil {
		doc.Coverage.Routes = len(digest.Routes)
		for _, dr := range digest.Routes {
			key := dr.Method + " " + dr.Path
			if t, ok := byKey[key]; ok {
				emit(key, t)
			} else {
				doc.Coverage.Unmatched = append(doc.Coverage.Unmatched, key)
			}
		}
		for _, key := range order {
			if !matched[key] {
				emit(key, byKey[key])
				if matched[key] {
					doc.Coverage.Extra = append(doc.Coverage.Extra, key)
				}
			}
		}
	} else {
		doc.Coverage.Routes = len(order)
		sort.Strings(order)
		for _, key := range order {
			emit(key, byKey[key])
		}
	}
	return doc
}

func gitRev(dir string) string {
	revOut, err := exec.Command("git", "-C", dir, "rev-parse", "--short", "HEAD").Output()
	if err != nil {
		return "unknown"
	}
	rev := strings.TrimSpace(string(revOut))
	if status, err := exec.Command("git", "-C", dir, "status", "--porcelain").Output(); err == nil && len(strings.TrimSpace(string(status))) > 0 {
		rev += "+dirty"
	}
	return rev
}

// returnedFuncLit finds the closure a handler constructor returns:
// `return func(w http.ResponseWriter, r *http.Request) { … }`.
func returnedFuncLit(decl *ast.FuncDecl) *ast.FuncLit {
	if decl.Body == nil {
		return nil
	}
	var lit *ast.FuncLit
	ast.Inspect(decl.Body, func(n ast.Node) bool {
		if lit != nil {
			return false
		}
		ret, ok := n.(*ast.ReturnStmt)
		if !ok {
			return true
		}
		for _, res := range ret.Results {
			if fl, ok := res.(*ast.FuncLit); ok {
				lit = fl
				return false
			}
		}
		return true
	})
	return lit
}
