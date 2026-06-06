package webhook

import (
	"os"
	"time"
	"whatsapp-mcp/config"
)

// Config holds the webhook system configuration.
type Config struct {
	PrimaryURL        string          // From WEBHOOK_URL env var
	MaxRetries        int             // Maximum delivery retry attempts
	RetryBackoff      []time.Duration // Backoff duration between retries
	DeliveryTimeout   time.Duration   // HTTP request timeout
	WorkerPoolSize    int             // Number of concurrent delivery workers
	ChannelBufferSize int             // Size of delivery queue buffer
	AllowedChatJIDs   map[string]bool // From ALLOWED_CHAT_JIDS env var (empty = all chats)
}

// LoadConfig loads webhook configuration from environment variables.
func LoadConfig() *Config {
	retryBackoff := []time.Duration{0, 5 * time.Second, 15 * time.Second}
	maxRetries := config.GetEnvInt("WEBHOOK_MAX_RETRIES", 3)

	// Cap MaxRetries to the length of RetryBackoff to prevent array out of bounds
	if maxRetries > len(retryBackoff) {
		maxRetries = len(retryBackoff)
	}

	allowedChats := make(map[string]bool)
	for _, jid := range config.GetEnvStringSlice("ALLOWED_CHAT_JIDS") {
		allowedChats[jid] = true
	}

	return &Config{
		PrimaryURL:        os.Getenv("WEBHOOK_URL"),
		MaxRetries:        maxRetries,
		RetryBackoff:      retryBackoff,
		DeliveryTimeout:   time.Duration(config.GetEnvInt("WEBHOOK_TIMEOUT_SECONDS", 10)) * time.Second,
		WorkerPoolSize:    config.GetEnvInt("WEBHOOK_WORKER_POOL_SIZE", 3),
		ChannelBufferSize: 100,
		AllowedChatJIDs:   allowedChats,
	}
}
