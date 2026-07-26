// widgets — the inline-pool handler style: closure over a querier interface,
// SQL assembled from a package const + literal.
package widgets

import (
	"net/http"

	"fixtureapp/pg"
)

const widgetCols = `id, name, created_at`

func ListWidgets(db *pg.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.Query(r.Context(), `SELECT `+widgetCols+` FROM widgets WHERE org_id = $1 ORDER BY created_at`, 1)
		if err != nil {
			return
		}
		defer rows.Close()
	}
}

func DeleteWidget(db *pg.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		_ = db.Exec(r.Context(), `DELETE FROM widgets WHERE id = $1`, r.URL.Query().Get("id"))
	}
}

// SearchWidgets builds its SQL dynamically — flowscan must flag it partial.
func SearchWidgets(db *pg.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		table := "widgets_" + r.URL.Query().Get("shard")
		_, _ = db.Query(r.Context(), "SELECT id FROM "+table, nil)
	}
}
