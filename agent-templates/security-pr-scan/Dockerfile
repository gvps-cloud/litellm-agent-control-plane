FROM node:22-slim

# Security scanning tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# semgrep (pinned)
RUN pip3 install --no-cache-dir --break-system-packages semgrep==1.72.0

# gitleaks (pinned) — download and verify SHA-256 checksum before extracting
RUN set -eux; \
    ARCH=$(dpkg --print-architecture); \
    GITLEAKS_VERSION=8.18.4; \
    TARBALL="gitleaks_${GITLEAKS_VERSION}_linux_${ARCH}.tar.gz"; \
    curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${TARBALL}" \
         -o /tmp/gitleaks.tar.gz; \
    curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_checksums.txt" \
         -o /tmp/gitleaks_checksums.txt; \
    grep "${TARBALL}" /tmp/gitleaks_checksums.txt | sha256sum -c -; \
    tar -xz -C /usr/local/bin -f /tmp/gitleaks.tar.gz gitleaks; \
    rm /tmp/gitleaks.tar.gz /tmp/gitleaks_checksums.txt

# Create non-root user — claude's bypassPermissions mode is blocked as root
RUN useradd -m -u 1001 agent

WORKDIR /home/agent

# Copy pre-built node_modules + dist. Overwrite @lap/managed-tools symlink with real dir.
COPY --chown=agent:agent harnesses/claude-agent-sdk/package.json ./
COPY --chown=agent:agent harnesses/claude-agent-sdk/node_modules/ ./node_modules/
COPY --chown=agent:agent managed-tools/ ./node_modules/@lap/managed-tools/
COPY --chown=agent:agent harnesses/claude-agent-sdk/dist/ ./dist/

# Install platform-native claude binary as the agent user
USER agent
RUN arch=$(uname -m) && \
    if [ "$arch" = "aarch64" ]; then \
      npm install @anthropic-ai/claude-agent-sdk-linux-arm64 --no-save --legacy-peer-deps; \
    else \
      npm install @anthropic-ai/claude-agent-sdk-linux-x64 --no-save --legacy-peer-deps; \
    fi

RUN echo '#!/bin/sh' > /home/agent/entrypoint.sh && \
    echo 'mkdir -p ~/.claude' >> /home/agent/entrypoint.sh && \
    echo 'echo "{\"env\":{\"ANTHROPIC_BASE_URL\":\"${LITELLM_API_BASE%/}\",\"ANTHROPIC_AUTH_TOKEN\":\"${LITELLM_API_KEY}\",\"ANTHROPIC_API_KEY\":\"${LITELLM_API_KEY}\"}}" > ~/.claude/settings.json' >> /home/agent/entrypoint.sh && \
    echo 'exec node /home/agent/dist/server.js' >> /home/agent/entrypoint.sh && \
    chmod +x /home/agent/entrypoint.sh

ENV PORT=4096
EXPOSE 4096
CMD ["/home/agent/entrypoint.sh"]
