This package uses the bundled `@openai/codex` dependency by default.
Set `CODEX_PATH` to run a different Codex binary; versions other than the one specified in `package.json` may not be compatible.

| Workflow | Native lifecycle | Completion boundary |
| --- | --- | --- |
| Manual `/compact` | `thread/compact/start`, then `turn/started` | Matching `turn/completed`, including failure or interruption |
| Stop during compaction | `turn/interrupt` for the captured thread and turn | The prompt remains owned until the native turn ends or the connection closes |

The compact start and interrupt responses only acknowledge their requests.
Cancellation before the native turn arrives is retained and interrupts that turn
when its id becomes known. Only the matching native terminal notification can
complete compaction; local interruption fallbacks and compaction item notifications
cannot release its prompt. See the [cancellation boundary decision](.agents/notes/implemented/bug-fix/2026-09-12-native-compaction-cancellation.md).

### Runtime environment

- `CODEX_API_KEY` - API key used when the API-key auth method is selected. Takes precedence over `OPENAI_API_KEY`.
- `OPENAI_API_KEY` - fallback API key used when the API-key auth method is selected.
- `CODEX_PATH` - run a specific Codex executable instead of the bundled package dependency.
- `CODEX_CONFIG` - JSON object merged into the Codex session config.
- `MODEL_PROVIDER` - model provider to pass to Codex for new sessions.
- `DEFAULT_AUTH_REQUEST` - ACP auth request JSON used when Codex requires authentication.
- `INITIAL_AGENT_MODE` - initial mode id: `read-only`, `agent`, `agent-auto-review`, or `agent-full-access`.
- `NO_BROWSER` - hide browser-based ChatGPT auth when set.
- `APP_SERVER_LOGS` - directory for adapter logs.

### Quick start

#### Develop on Windows?

- Download and install [C++ redistributable package](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170#latest-supported-redistributable-version)

#### Adjust ACP client config

Run from sources

1. Install dependencies `npm install`
2. Adjust ACP client config

```json
{
  "agent_servers": {
    "Codex (app-server)": {
      "command": "npm",
      "args": ["run", "start", "--prefix", "/path/to/project/"],
      "env": {
        "CODEX_PATH": "node_modules/.bin/codex",
        "APP_SERVER_LOGS": "optional/path/to/existing/log/directory"
      }
    }
  }
}
```

Run from binaries

1. Download an `acp-extension-codex-<arch>-<platform>.zip` archive from https://github.com/Leeeon233/acp-extension-codex/releases (`<arch>` is `x64` or `arm64`; `<platform>` is `linux`, `darwin`, or `windows`).
2. Unzip the archive:
   ```bash
   unzip acp-extension-codex-<arch>-<platform>.zip
   ```
3. Adjust ACP client config

```json
{
  "agent_servers": {
    "Codex (app-server)": {
      "command": "/path/to/acp-extension-codex",
      "env": {
        "CODEX_PATH": "/path/to/codex"
      }
    }
  }
}
```

### Build binaries

Building standalone binaries requires [bun](https://bun.com/docs/installation).

Build single-file executables in `dist/bin` directory:

```bash
npm run bundle:all
```

Package binaries into zip archives:

```bash
npm run package:all
```

### Update supported Codex version

1. Update the `@openai/codex` version in `package.json` (under `dependencies`).
2. Regenerate Codex types in `src/app-server/`: `npm run generate-types`
3. Ensure there are no type errors or failed tests: `npm run typecheck` and `npm run test`

## Plan configuration

Codex translates Core’s boolean `plan_mode` option to its native default/plan collaboration state. Approval and sandbox settings are retained. The `/plan` command uses the same boolean configuration path.
