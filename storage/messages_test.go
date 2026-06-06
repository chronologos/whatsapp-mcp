package storage

import (
	"database/sql"
	"os"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// newTestStore creates an in-memory database with the real schema applied.
func newTestStore(t *testing.T) *MessageStore {
	t.Helper()

	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("failed to open in-memory db: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	schema, err := os.ReadFile("migrations/001_initial_schema.sql")
	if err != nil {
		t.Fatalf("failed to read schema migration: %v", err)
	}
	if _, err := db.Exec(string(schema)); err != nil {
		t.Fatalf("failed to apply schema: %v", err)
	}

	return NewMessageStore(db)
}

func TestSearchMessagesWithNamesFiltered_ChatScope(t *testing.T) {
	store := newTestStore(t)

	now := time.Now()
	messages := []Message{
		{ID: "m1", ChatJID: "family@g.us", SenderJID: "alice@s.whatsapp.net", Text: "hello family", Timestamp: now, MessageType: "text"},
		{ID: "m2", ChatJID: "work@g.us", SenderJID: "bob@s.whatsapp.net", Text: "hello work", Timestamp: now, MessageType: "text"},
		{ID: "m3", ChatJID: "family@g.us", SenderJID: "carol@s.whatsapp.net", Text: "dinner plans", Timestamp: now, MessageType: "text"},
	}
	if err := store.SaveBulk(messages); err != nil {
		t.Fatalf("failed to save messages: %v", err)
	}

	t.Run("unscoped search returns all chats", func(t *testing.T) {
		results, err := store.SearchMessagesWithNamesFiltered("hello", false, "", 50, nil)
		if err != nil {
			t.Fatalf("search failed: %v", err)
		}
		if len(results) != 2 {
			t.Errorf("expected 2 results, got %d", len(results))
		}
	})

	t.Run("scoped search excludes other chats", func(t *testing.T) {
		results, err := store.SearchMessagesWithNamesFiltered("hello", false, "", 50, []string{"family@g.us"})
		if err != nil {
			t.Fatalf("search failed: %v", err)
		}
		if len(results) != 1 {
			t.Fatalf("expected 1 result, got %d", len(results))
		}
		if results[0].ChatJID != "family@g.us" {
			t.Errorf("expected result from family@g.us, got %s", results[0].ChatJID)
		}
	})

	t.Run("scoped search with multiple allowed chats", func(t *testing.T) {
		results, err := store.SearchMessagesWithNamesFiltered("hello", false, "", 50, []string{"family@g.us", "work@g.us"})
		if err != nil {
			t.Fatalf("search failed: %v", err)
		}
		if len(results) != 2 {
			t.Errorf("expected 2 results, got %d", len(results))
		}
	})

	t.Run("sender-only search respects scope", func(t *testing.T) {
		// bob only posts in work@g.us, which is out of scope
		results, err := store.SearchMessagesWithNamesFiltered("", false, "bob@s.whatsapp.net", 50, []string{"family@g.us"})
		if err != nil {
			t.Fatalf("search failed: %v", err)
		}
		if len(results) != 0 {
			t.Errorf("expected 0 results for out-of-scope sender, got %d", len(results))
		}
	})
}
