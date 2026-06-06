# Pi-powered WhatsApp bot agent.
# Runs the Pi coding agent (Gemini) restricted to the WhatsApp MCP tools.
FROM node:24-bookworm-slim

# CA certs for outbound TLS (Gemini API).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Pi globally.
RUN npm install -g @earendil-works/pi-coding-agent

# Unprivileged user.
RUN useradd -m -u 10001 agent
USER agent
ENV HOME=/home/agent
WORKDIR /home/agent/app

# Install the MCP extension into Pi's global extension dir (auto-discovered).
RUN mkdir -p /home/agent/.pi/agent/extensions
COPY --chown=agent:agent extensions/whatsapp-mcp.ts /home/agent/.pi/agent/extensions/whatsapp-mcp.ts

# Custom model registry (adds models not in Pi's bundled list, e.g. gemini-3.5-flash).
COPY --chown=agent:agent models.json /home/agent/.pi/agent/models.json

# Supervisor + system prompt.
COPY --chown=agent:agent bot.mjs system-prompt.md ./

CMD ["node", "bot.mjs"]
