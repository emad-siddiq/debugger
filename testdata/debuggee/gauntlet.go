package main

// The fixture gauntlet (task 04.6) — the shapes the inspector has to survive,
// not a program that does anything useful. main.go stays the small, readable
// case (`add`, a 4-level cfg); everything hostile lives here.
//
// Reached by the "Debug debuggee (gauntlet)" launch config, which sets
// BURROW_GAUNTLET=1. Plain `go run .` skips it, so the fixture stays cheap for
// every other test: building 50k+10k elements costs ~10 ms but the point is to
// keep main.go's frame small and predictable for the WO-8 ghost-value checks.

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"sync"
	"time"
)

// L1..L8 — eight levels of nesting, matching the acceptance criterion
// "reaching any value nested 8 levels deep never shows more than breadcrumb +
// two columns". Each level carries a scalar so every column has something to
// summarize, not just a single "▸ Next" row to click through.
type L8 struct {
	Name  string
	Value int
}
type L7 struct {
	Depth int
	Next  L8
}
type L6 struct {
	Depth int
	Next  L7
}
type L5 struct {
	Depth int
	Next  L6
}
type L4 struct {
	Depth int
	Next  L5
}
type L3 struct {
	Depth int
	Next  L4
}
type L2 struct {
	Depth int
	Next  L3
}
type L1 struct {
	Depth int
	Label string
	Next  L2
}

// Node is the map's value type — a composite, so the 10k-key map is a map of
// things you can drill into rather than a map of scalars.
type Node struct {
	ID    int
	Label string
	Tags  []string
}

func deep() L1 {
	return L1{
		Depth: 1,
		Label: "root",
		Next: L2{Depth: 2, Next: L3{Depth: 3, Next: L4{Depth: 4,
			Next: L5{Depth: 5, Next: L6{Depth: 6, Next: L7{Depth: 7,
				Next: L8{Name: "bottom", Value: 42}}}}}}},
	}
}

const (
	bigSliceLen = 50000 // acceptance: "a 50k-element slice … stays responsive (paged)"
	bigMapLen   = 10000 // acceptance: "… and a 10k-key map"
)

func bigSlice() []int {
	xs := make([]int, bigSliceLen)
	for i := range xs {
		xs[i] = i * i
	}
	return xs
}

func bigMap() map[string]Node {
	m := make(map[string]Node, bigMapLen)
	for i := 0; i < bigMapLen; i++ {
		k := "key-" + strconv.Itoa(i)
		m[k] = Node{ID: i, Label: k, Tags: []string{"a", "b"}}
	}
	return m
}

// The goroutine storm (task 04.6) — the Frames view's goroutine switcher needs
// more than one goroutine, and needs them in DIFFERENT states, or "switch to an
// interesting goroutine" has nothing to be interesting about.
//
// Three flavours, all parked in a way dlv reports distinctly: blocked on a
// channel receive, blocked on a mutex main holds, and sleeping. `started` gates
// the breakpoint on every goroutine having actually reached its blocking call —
// without it the storm races the stop and the fixture reports a different set of
// goroutines every run.
const (
	blockedOnChan  = 3
	blockedOnMutex = 2
	sleeping       = 3
)

type storm struct {
	ch      chan int
	mu      sync.Mutex
	started sync.WaitGroup
}

func (s *storm) start() {
	s.ch = make(chan int)
	s.started.Add(blockedOnChan + blockedOnMutex + sleeping)
	s.mu.Lock() // held for the whole run, so the mutex waiters stay parked

	for i := 0; i < blockedOnChan; i++ {
		go func(id int) {
			s.started.Done()
			<-s.ch // parks until the process exits
		}(i)
	}
	for i := 0; i < blockedOnMutex; i++ {
		go func(id int) {
			s.started.Done()
			s.mu.Lock()
			defer s.mu.Unlock()
		}(i)
	}
	for i := 0; i < sleeping; i++ {
		go func(id int) {
			s.started.Done()
			time.Sleep(time.Hour)
		}(i)
	}
	s.started.Wait()
	// `started.Done()` returns before the goroutine reaches its blocking call, so
	// yield until the scheduler has actually parked them all. A sleep is crude but
	// the alternative — instrumenting each park — would change what dlv reports.
	time.Sleep(50 * time.Millisecond)
	runtime.Gosched()
}

// gauntlet stops with all the hostile shapes live in one frame, so a single
// stop exercises deep drilling AND both paging paths. The measured case for
// task 05.8 (stop → painted inspector < 150 ms) is this frame.
func gauntlet() {
	root := deep()
	nums := bigSlice()
	nodes := bigMap()
	labels := []string{"alpha", "beta", "gamma"}
	ptr := &root.Next.Next
	var nilPtr *Node
	var err error

	var s storm
	s.start()

	if os.Getenv("BURROW_GAUNTLET") != "" {
		runtime.Breakpoint()
	}

	// Keep every local live past the breakpoint — the compiler is free to
	// reclaim a variable at its last use, and a reclaimed local reads as
	// "optimized out" in the inspector, which would make the fixture lie.
	fmt.Println(root.Label, len(nums), len(nodes), labels[0], ptr.Depth, nilPtr == nil, err == nil, cap(s.ch))
}
