package main

import (
	"fmt"
	"os"
	"runtime"
)

// add returns a + b. When BURROW_DEBUG_BREAK is set (the debug launch config
// sets it), it calls runtime.Breakpoint(), so a session attached via `dlv dap`
// stops inside add() with a, b and sum in scope. This lets WO-2 prove the Call
// Stack + Variables DAP model headlessly; `go run .` (no env var) runs clean.
func add(a, b int) int {
	sum := a + b
	if os.Getenv("BURROW_DEBUG_BREAK") != "" {
		runtime.Breakpoint()
	}
	return sum
}

func main() {
	nums := []int{2, 3, 5, 7, 11}
	total := 0
	for _, n := range nums {
		total = add(total, n)
	}
	fmt.Println("total:", total)
}
