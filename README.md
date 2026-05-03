# KarsaCode

KarsaCode is a minimal web GUI for coding agents (currently Codex and Claude, more coming soon).

**Developed by Tool4File**

## Supported Providers

KarsaCode currently supports these coding agents:

- **Codex**: Install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
- **Claude**: Install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
- **OpenCode**: Install [OpenCode](https://opencode.ai) and run `opencode auth login`

## Development

### Setup

```bash
# Install dependencies
bun install .

# Optional: only needed if you use mise for dev tool management
mise install
```

### Running the Application

```bash
# Development mode
bun dev

# Build
bun build

# Type checking
bun typecheck

# Linting
bun lint

# Formatting
bun fmt
```

## Documentation

- Observability guide: [docs/observability.md](./docs/observability.md)
- Keybindings: [KEYBINDINGS.md](./KEYBINDINGS.md)
- Remote access: [REMOTE.md](./REMOTE.md)

## Support

For internal support and questions, contact the development team.
