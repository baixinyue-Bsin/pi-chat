# Advanced configuration

This guide is for developers and advanced users who run Pi Chat from source, integrate it with other tools, or expose it beyond the local Mac. A normal DMG installation does not require these settings.

## Environment variables and startup options

Command-line options take precedence over the matching port, hostname, and browser-opening environment variables. The `pi-chat --help` (or `-h`) command prints the available startup options.

| Variable | Purpose | Default or notes |
| --- | --- | --- |
| `PI_CODING_AGENT_DIR` | Use a different local Pi data directory for model settings, credentials, and conversations. | The Pi default is used when unset. Keep this directory private. |
| `PI_WEB_SKIP_VERSION_CHECK=1` | Skip Pi Chat version checks. | Version checks run when unset. |
| `PI_WEB_IDLE_TIMEOUT_MS` | Set the session idle timeout in milliseconds. | `600000` (10 minutes). `0` disables idle shutdown; values above `2147483647`, invalid values, or negative values use the default. |
| `PI_WEB_ALLOWED_HOSTS` | Allow additional exact proxy or custom hostnames, separated by commas. | Unset. This is an exact allow-list and does not change the bind address. |
| `PORT` | Set the local server port. | `30141`; `--port` or `-p` takes precedence. |
| `PI_WEB_HOSTNAME` | Set the hostname or address to bind. | `127.0.0.1`; `--hostname` or `-H` takes precedence. |
| `PI_WEB_NO_OPEN=1` | Do not open a browser automatically when the server starts. | The browser opens by default; `--no-open` has the same effect. |
| `PI_WEB_PASSWORD` | Require a password for browser access. API clients can use Basic Auth with username `pi`. | Authentication is disabled when unset. Use a long random value. |

For example:

```bash
PORT=8080 PI_WEB_NO_OPEN=1 npm start
```

## HTTP proxy

Server-side model and API requests honor the standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` variables. Keep local addresses in `NO_PROXY` when appropriate:

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npm start
```

These variables affect requests made by the server. They do not change the browser's own proxy settings.

## Remote access and HTTPS

Pi Chat can perform actions with access to the selected project files and configured model credentials. Binding to a non-loopback address therefore requires care:

1. Set `PI_WEB_PASSWORD` to a long, random password.
2. Prefer a trusted VPN or a trusted reverse proxy that terminates HTTPS.
3. If a reverse proxy sends an external hostname, add that exact hostname to `PI_WEB_ALLOWED_HOSTS`.
4. Do not expose Pi Chat to the public internet over plain HTTP. Password authentication does not encrypt the connection.

Example for a trusted LAN:

```bash
PI_WEB_PASSWORD='use-a-long-random-password' \
PI_WEB_HOSTNAME=0.0.0.0 \
npm start
```

The host allow-list controls which `Host` values are accepted; it does not make an unsafe network exposure safe by itself.

## Git worktrees

Pi Chat can switch between worktrees of a Git repository while grouping their conversations under the same project. The selected worktree affects new sessions and the file Explorer; an existing conversation keeps the checkout it was created with. See [Worktrees in Pi Chat](./worktrees.md) and [Pi Chat 里的 Worktree](./worktrees.zh-CN.md) for creation, switching, and removal details.

Removing a worktree with uncommitted or untracked files requires a force action and discards those files. The Git branch, main checkout, and conversation history are not removed by deleting a linked worktree.

## Extension integration

Extensions can integrate with the browser without modifying Pi Chat components.

### Session-row context menu

An Electron wrapper or another downstream integration can listen for the cancelable `pi-web:session-row-contextmenu` event. Call `preventDefault()` synchronously when the integration will provide its own menu; otherwise Pi Chat keeps the browser's native context menu.

```js
window.addEventListener("pi-web:session-row-contextmenu", (event) => {
  event.preventDefault();
  const { id, path, cwd, name, clientX, clientY, refresh } = event.detail;

  void openSessionMenu({ id, path, cwd, name, clientX, clientY }).then((changed) => {
    if (changed) refresh();
  });
});
```

The detail object contains the session id and path, working directory, optional name, pointer coordinates, and a `refresh()` callback for actions that change the session list.

### Keeping detached extension work alive

Server-side extensions that have detached work can register a liveness lease so an idle session is not evicted while that work is active. The versioned registry is exposed through `globalThis`:

```js
const liveness = globalThis[Symbol.for("@agegr/pi-web/session-liveness/v1")];
const release = liveness?.version === 1
  ? liveness.register({
      name: "my-extension",
      sessionId,
      sessionFile: sessionFile || undefined,
      isActive: () => detachedJobs.size > 0,
    })
  : () => {};
```

Register once for each active extension session and call the returned idempotent `release` function when the session shuts down, is replaced, or reloads. `isActive` must be synchronous, cheap, and scoped to the exact session id or file. This lease only affects automatic idle eviction; explicit shutdown and Stop cleanup still take precedence.

## File access limits

The file browser is intentionally limited. It can read working directories selected in Pi Chat, project or session roots already known to the app, and other roots explicitly allowed by the running instance. It is not a general browser for every file on the Mac.

Keep projects and session data in locations that the Pi Chat process can access. A file can be outside the browser's allowed roots even when the operating-system account can read it. Review the selected project and any Skill before sending confidential files to a model provider or external service.

## Related developer documentation

- [Internationalization](./i18n.md)
- [Release process](./release.md)
- [Worktrees in Pi Chat](./worktrees.md)
- [Pi Chat 里的 Worktree](./worktrees.zh-CN.md)
- [MIT License](../LICENSE)
