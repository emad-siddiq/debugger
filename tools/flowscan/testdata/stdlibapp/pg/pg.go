// pg — a stand-in for pgxpool with the structural querier signature.
package pg

import "context"

type Rows struct{}

func (r *Rows) Next() bool          { return false }
func (r *Rows) Close()              {}
func (r *Rows) Err() error          { return nil }
func (r *Rows) Scan(...any) error   { return nil }

type Row struct{}

func (r *Row) Scan(...any) error { return nil }

type Pool struct{}

func (p *Pool) Query(ctx context.Context, sql string, args ...any) (*Rows, error) {
	return &Rows{}, nil
}
func (p *Pool) QueryRow(ctx context.Context, sql string, args ...any) *Row { return &Row{} }
func (p *Pool) Exec(ctx context.Context, sql string, args ...any) error    { return nil }
