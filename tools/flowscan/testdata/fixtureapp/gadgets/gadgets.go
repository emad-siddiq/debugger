// gadgets — the store-interface handler style: handlers take an unexported
// interface, the router injects the concrete Pgx store.
package gadgets

import (
	"context"
	"net/http"

	"fixtureapp/pg"
)

type gadgetStore interface {
	Fetch(ctx context.Context, id string) (string, error)
	Insert(ctx context.Context, name string) error
}

type PgxGadgetStore struct {
	Pool *pg.Pool
}

func (s *PgxGadgetStore) Fetch(ctx context.Context, id string) (string, error) {
	var name string
	err := s.Pool.QueryRow(ctx, `
		SELECT g.name
		  FROM gadgets g
		  JOIN gizmos z ON z.gadget_id = g.id
		 WHERE g.id = $1`, id).Scan(&name)
	return name, err
}

func (s *PgxGadgetStore) Insert(ctx context.Context, name string) error {
	return s.Pool.Exec(ctx, `INSERT INTO gadgets (name) VALUES ($1)`, name)
}

func GetGadget(s gadgetStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		_, _ = s.Fetch(r.Context(), r.URL.Query().Get("id"))
	}
}

func CreateGadget(s gadgetStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		_ = s.Insert(r.Context(), r.URL.Query().Get("name"))
	}
}

// Notifier has two implementations — flowscan must report the hop as
// unresolvable instead of guessing.
type Notifier interface {
	Notify(ctx context.Context, msg string) error
}

type EmailNotifier struct{ Pool *pg.Pool }

func (n *EmailNotifier) Notify(ctx context.Context, msg string) error {
	return n.Pool.Exec(ctx, `INSERT INTO email_outbox (msg) VALUES ($1)`, msg)
}

type SlackNotifier struct{ Pool *pg.Pool }

func (n *SlackNotifier) Notify(ctx context.Context, msg string) error {
	return n.Pool.Exec(ctx, `INSERT INTO slack_outbox (msg) VALUES ($1)`, msg)
}

func PickNotifier() Notifier { return &EmailNotifier{} }

func NotifyGadget(n Notifier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		_ = n.Notify(r.Context(), "gadget event")
	}
}
