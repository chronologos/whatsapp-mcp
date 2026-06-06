package mcp

import (
	"log"
	"time"

	"whatsapp-mcp/storage"
	"whatsapp-mcp/whatsapp"

	"github.com/mark3labs/mcp-go/server"
)

// MCPServer represents an MCP server instance for WhatsApp integration.
type MCPServer struct {
	server       *server.MCPServer
	wa           *whatsapp.Client
	store        *storage.MessageStore
	mediaStore   *storage.MediaStore
	log          *log.Logger
	timezone     *time.Location
	allowedChats []string        // ordered list for SQL filters (empty = no restriction)
	allowedSet   map[string]bool // fast lookup of the same JIDs
}

// NewMCPServer creates a new MCP server with the provided WhatsApp client and storage.
// If allowedChatJIDs is non-empty, all tools and resources are restricted to those chats.
func NewMCPServer(wa *whatsapp.Client, store *storage.MessageStore, mediaStore *storage.MediaStore, timezone *time.Location, allowedChatJIDs []string) *MCPServer {
	instructions := `WhatsApp integration for messaging operations.

Key workflow: find_chat → get_chat_messages or send_message
Always get chat_jid from find_chat before other operations.
JIDs are WhatsApp identifiers (e.g., 5511999999999@s.whatsapp.net).

Use prompts for common workflows or resources for detailed guides.`

	if len(allowedChatJIDs) > 0 {
		instructions += "\n\nThis server is scoped to specific chats. Operations on other chats will be rejected."
	}

	s := server.NewMCPServer(
		"WhatsApp MCP",
		"1.0.0",
		server.WithInstructions(instructions),
		server.WithToolCapabilities(true),
		server.WithPromptCapabilities(true),
		server.WithResourceCapabilities(true, true),
		server.WithRecovery(),
	)

	allowedSet := make(map[string]bool, len(allowedChatJIDs))
	for _, jid := range allowedChatJIDs {
		allowedSet[jid] = true
	}

	m := &MCPServer{
		server:       s,
		wa:           wa,
		store:        store,
		mediaStore:   mediaStore,
		log:          log.Default(),
		timezone:     timezone,
		allowedChats: allowedChatJIDs,
		allowedSet:   allowedSet,
	}

	// register all capabilities
	m.registerTools()
	m.registerPrompts()
	m.registerResources()

	return m
}

// isChatAllowed reports whether a chat JID is within the configured scope.
// An empty allowlist means all chats are allowed.
func (m *MCPServer) isChatAllowed(jid string) bool {
	return len(m.allowedSet) == 0 || m.allowedSet[jid]
}

// chatScopeError returns the error message for an out-of-scope chat access.
func chatScopeError(jid string) string {
	return "chat " + jid + " is outside this server's configured scope (ALLOWED_CHAT_JIDS)"
}

// GetServer returns the underlying MCP server instance.
func (m *MCPServer) GetServer() *server.MCPServer {
	return m.server
}
