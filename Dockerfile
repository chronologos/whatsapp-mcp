# Build stage
FROM golang:1.25.5-alpine3.23 AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache gcc musl-dev

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build application (migrations are embedded via go:embed, so the binary is self-contained)
RUN CGO_ENABLED=1 GOOS=linux go build -o whatsapp-mcp

# Runtime stage
FROM alpine:3.23

RUN apk --no-cache add ca-certificates sqlite curl tzdata

# Create an unprivileged user to run the server
RUN addgroup -S app && adduser -S -G app app

WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/whatsapp-mcp .

# Pre-create the data directory and hand ownership to the unprivileged user.
# At runtime this is overlaid by the ./data volume (see docker-compose.yml).
RUN mkdir -p /app/data && chown -R app:app /app

# Drop to the unprivileged user
USER app

# Expose MCP server port
EXPOSE 8080

# Run application
CMD ["./whatsapp-mcp"]
