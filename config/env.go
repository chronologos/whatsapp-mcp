// Package config provides utilities for loading configuration from environment variables.
package config

import (
	"os"
	"strconv"
	"strings"
)

// GetEnv gets an environment variable with a fallback default value.
func GetEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}

// GetEnvBool gets a boolean environment variable with a fallback default value.
func GetEnvBool(key string, defaultVal bool) bool {
	val := os.Getenv(key)
	if val == "" {
		return defaultVal
	}
	b, err := strconv.ParseBool(val)
	if err != nil {
		return defaultVal
	}
	return b
}

// GetEnvInt gets an integer environment variable with a fallback default value.
func GetEnvInt(key string, defaultVal int) int {
	val := os.Getenv(key)
	if val == "" {
		return defaultVal
	}
	i, err := strconv.Atoi(val)
	if err != nil {
		return defaultVal
	}
	return i
}

// GetEnvStringSlice gets a comma-separated environment variable as a slice.
// Entries are trimmed of whitespace and empty entries are dropped.
// It returns nil if the variable is unset or contains no entries.
func GetEnvStringSlice(key string) []string {
	val := os.Getenv(key)
	if val == "" {
		return nil
	}

	var result []string
	for _, entry := range strings.Split(val, ",") {
		entry = strings.TrimSpace(entry)
		if entry != "" {
			result = append(result, entry)
		}
	}
	return result
}

// GetEnvInt64 gets an int64 environment variable with a fallback default value.
func GetEnvInt64(key string, defaultVal int64) int64 {
	val := os.Getenv(key)
	if val == "" {
		return defaultVal
	}
	i, err := strconv.ParseInt(val, 10, 64)
	if err != nil {
		return defaultVal
	}
	return i
}
