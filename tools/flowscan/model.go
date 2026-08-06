// model.go — the flows.json output shapes consumed by burrow-flow.
package main

// Output is the top-level flows.json document.
type Output struct {
	Schema      int               `json:"schema"`
	Backend     string            `json:"backend"`
	Rev         string            `json:"rev"`
	GeneratedAt string            `json:"generatedAt"`
	Coverage    Coverage          `json:"coverage"`
	Tables      map[string]string `json:"tables,omitempty"` // table -> creating migration (from digest)
	Flows       []*Flow           `json:"flows"`
}

// Coverage reconciles what flowscan traced against the digest route catalog.
type Coverage struct {
	Routes    int      `json:"routes"`
	Traced    int      `json:"traced"`
	Partial   int      `json:"partial"`
	Unknown   int      `json:"unknown"`
	Unmatched []string `json:"unmatched,omitempty"` // digest routes with no discovered registration
	Extra     []string `json:"extra,omitempty"`     // discovered registrations absent from the digest
	// Routers the walk RECOGNISED and could not follow. Not routes — we do not
	// know how many are behind one — so this is a separate list rather than a
	// fifth bucket. It is what lets a surface distinguish "this app has N routes"
	// from "I found N and there is a router in here I cannot read".
	Unfollowed []Unfollowed `json:"unfollowed,omitempty"`
}

// Unfollowed is one router hand-off the walk recognised and could not track.
type Unfollowed struct {
	File   string `json:"file"` // backend-relative
	Line   int    `json:"line"`
	Reason string `json:"reason"`
}

// Flow is one route's wire: middleware -> handler -> store methods -> SQL -> tables.
type Flow struct {
	Method     string   `json:"method"`
	Path       string   `json:"path"`
	File       string   `json:"file"` // registration site, backend-relative
	Line       int      `json:"line"`
	Middleware []MW     `json:"middleware,omitempty"`
	Nodes      []*Node  `json:"nodes"`
	Edges      []Edge   `json:"edges"`
	Tables     []string `json:"tables,omitempty"`
	Status     string   `json:"status"` // traced | partial | unknown
}

// Edge kinds — what one box does to the next. The relation is known exactly
// where the edge is built and used to be discarded: an edge was two integers,
// so every curve in the diagram meant the same unfalsifiable "this leads to
// that" and a reader had to open the code to find out which.
const (
	RelCalls      = "calls"      // a Go call: handler -> store method, store -> store
	RelExecutes   = "executes"   // this function runs this SQL statement
	RelReads      = "reads"      // the statement selects from / joins this table
	RelWrites     = "writes"     // the statement inserts, updates, deletes or truncates it
	RelUnresolved = "unresolved" // the hop was recognised and could not be followed
)

// Edge is one link in the wire, indexes into Nodes.
//
// File/Line/Col are the CALL SITE — the line in the parent that reaches the
// child — not either box's declaration. For a store hop those are different
// files: the box shows where the method is declared, the edge where it is
// called, and the second is the one that answers "why are these two joined".
type Edge struct {
	From int    `json:"from"`
	To   int    `json:"to"`
	Rel  string `json:"rel"`
	File string `json:"file,omitempty"`
	Line int    `json:"line,omitempty"`
	Col  int    `json:"col,omitempty"`
}

// MW is one middleware chip on the route's chain, in order.
//
// Branch/Arm are how a CONDITIONAL registration says so. The walk takes every
// arm of an if/else or switch, because a route registered in one arm is still a
// real route. Middleware is not like that: it is an ordered chain, and arms are
// mutually exclusive, so listing all of them flat claims a chain that can never
// run. merkle picks one of three CORS middlewares in an if/else-if/else
// (`app.go:398`) and all three were shown as if they stacked.
//
// Branch is 0 for an unconditional Use. Otherwise it identifies the if/switch,
// and entries sharing a Branch with DIFFERENT Arms are alternatives of which at
// most one runs.
type MW struct {
	Label  string `json:"label"`
	File   string `json:"file,omitempty"`
	Line   int    `json:"line,omitempty"`
	Branch int    `json:"branch,omitempty"`
	Arm    int    `json:"arm,omitempty"`
}

// Node kinds: handler | store | query | table | unknown.
type Node struct {
	Kind    string   `json:"kind"`
	Label   string   `json:"label"`
	File    string   `json:"file,omitempty"`
	Line    int      `json:"line,omitempty"`
	Col     int      `json:"col,omitempty"`
	SQL     string   `json:"sql,omitempty"`
	SQLKind string   `json:"sqlKind,omitempty"` // read | write
	Tables  []string `json:"tables,omitempty"`
	Partial bool     `json:"partial,omitempty"` // SQL only partially constant-folded
	Reason  string   `json:"reason,omitempty"`  // for kind=unknown
}
