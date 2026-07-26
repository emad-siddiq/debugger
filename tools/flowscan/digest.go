// digest.go — read the route catalog produced by the target project's oracle.
// Accepts either the raw fenced-markdown digest (test/cmd/oracle --digest) or
// the launcher's parsed /config/digest.json.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
)

// DigestRoute is one catalog entry: the authoritative method+path set flowscan
// reconciles its discovered registrations against.
type DigestRoute struct {
	Method  string `json:"method"`
	Path    string `json:"path"`
	Handler string `json:"handler"`
	File    string `json:"file"`
}

type Digest struct {
	Routes []DigestRoute
	Tables map[string]string // table -> creating migration
}

func loadDigest(path string) (*Digest, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, "{") {
		return parseDigestJSON(raw)
	}
	return parseDigestMarkdown(trimmed)
}

func parseDigestJSON(raw []byte) (*Digest, error) {
	var doc struct {
		Routes []DigestRoute     `json:"routes"`
		Tables map[string]string `json:"tables"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("digest json: %w", err)
	}
	return &Digest{Routes: doc.Routes, Tables: doc.Tables}, nil
}

// routeLineRe: `GET /api/nodes → nodes.ListNodes(a.Pool)  [router.go]`
var routeLineRe = regexp.MustCompile(`^([A-Z]+|\*) (\S+) → (.+?)\s+\[(.+)\]$`)

// tableLineRe: `nodes ← 001_init.sql`
var tableLineRe = regexp.MustCompile(`^(\S+) ← (\S+)$`)

func parseDigestMarkdown(text string) (*Digest, error) {
	d := &Digest{Tables: map[string]string{}}
	fence := "" // current fence tag ("routes", "tables", ...)
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.HasPrefix(line, "```") {
			if fence == "" {
				fence = strings.TrimSpace(strings.TrimPrefix(line, "```"))
			} else {
				fence = ""
			}
			continue
		}
		switch fence {
		case "routes":
			if m := routeLineRe.FindStringSubmatch(line); m != nil {
				d.Routes = append(d.Routes, DigestRoute{Method: m[1], Path: m[2], Handler: m[3], File: m[4]})
			}
		case "tables":
			if m := tableLineRe.FindStringSubmatch(line); m != nil {
				d.Tables[m[1]] = m[2]
			}
		}
	}
	if len(d.Routes) == 0 {
		return nil, fmt.Errorf("digest markdown: no routes fence found")
	}
	return d, nil
}
