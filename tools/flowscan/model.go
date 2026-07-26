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
}

// Flow is one route's wire: middleware -> handler -> store methods -> SQL -> tables.
type Flow struct {
	Method     string   `json:"method"`
	Path       string   `json:"path"`
	File       string   `json:"file"` // registration site, backend-relative
	Line       int      `json:"line"`
	Middleware []MW     `json:"middleware,omitempty"`
	Nodes      []*Node  `json:"nodes"`
	Edges      [][2]int `json:"edges"` // indexes into Nodes
	Tables     []string `json:"tables,omitempty"`
	Status     string   `json:"status"` // traced | partial | unknown
}

// MW is one middleware chip on the route's chain, in order.
type MW struct {
	Label string `json:"label"`
	File  string `json:"file,omitempty"`
	Line  int    `json:"line,omitempty"`
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
