# ✴️ Claude On Steroids

A custom connector that lets claude.ai work on your own computer. It can read and
search files, write and edit them, run shell commands and delete files. Claude
talks to it over remote MCP (Streamable HTTP), not through a browser extension.

Writes, edits, deletes and shell commands wait for your approval in a local panel.

```
claude.ai  ---HTTPS--->  tunnel  --->  127.0.0.1:8857/mcp/<secret>
                                        |
                                        v
                                 approval queue
                                        |
                                        v
                you  <---  127.0.0.1:8858 panel (this computer only)
```

## Requirements

Node.js 18 or newer. Windows is the main target; the server also runs on macOS and
Linux, where commands go through `/bin/sh` instead of `cmd.exe`. You need a tunnel
to publish the MCP endpoint. The panel can install Cloudflare's `cloudflared` for
you on Windows and Linux; on macOS run `brew install cloudflared`, or pick another
provider from the list in the panel.

## Setup

1. The first time, double-click `setup.bat`. It checks that Node.js 18 or newer
   is installed and installs the dependencies. Then double-click `start.bat` to
   boot the server; it opens the panel in your browser. (`start.bat` installs the
   dependencies too if it finds none, so setup is only needed once.) To run it
   from a terminal instead:

   ```bash
   node src/server.mjs
   ```

2. Follow the panel from top to bottom.
   - **Access:** add the folders Claude may touch. The default is
     `Desktop\opencode projeler`.
   - **Connection:** if no tunnel is open, press **Install cloudflared**. It
     downloads the official Cloudflare release into `~/.claude-on-steroids/bin`.
     No account is needed, and the tunnel starts on its own.
   - **Connector URL:** copy the address, open claude.ai, then
     **Settings > Connectors > Add custom connector**. Name it `Claude-On-Steroids`,
     paste the URL, and leave the OAuth fields empty.
   - **Try it in a chat:** turn the connector on and ask it to run the
     `machine_info` tool. The panel switches to "claude.ai connected" once it
     reaches the server.

## Tools

| Tool | What it does | Approval |
|---|---|---|
| `machine_info` | host, roots, current permissions | none |
| `list_dir`, `read_file`, `search` | reading | none |
| `write_file`, `edit_file` | writing | panel, unless you turn auto-approve on |
| `exec_command` | shell command (`cmd.exe` on Windows) | panel, unless you turn auto-approve on for safe commands |
| `delete_file` | deleting | always the panel |

Destructive commands (`del`, `rm -rf`, `format`, `diskpart`, `git reset --hard`,
`git push --force`, `curl ... | sh` and similar) ask in the panel even with
auto-approve on. An approval nobody answers within 110 seconds is denied, and
Claude is told why.

## Security

- MCP answers only on `/mcp/<64 hex characters>`; anything else gets an empty 404.
  If the address leaks, press **Rotate address** in the panel, then update the
  connector in claude.ai.
- The panel listens on `127.0.0.1` only, needs the panel key, and rejects a
  foreign `Host` header (DNS rebinding) or a POST from another origin (CSRF).
- Every path must sit inside an approved root. A symlink or junction inside a root
  that points somewhere else is refused.
- Commands run with your normal user permissions, so keep the roots narrow.
  Approving all of `C:\` is not a good idea.
- Every call is appended to `~/.claude-on-steroids/calls.jsonl`.

## Settings

`~/.claude-on-steroids/config.json`, also editable from the panel:

| Field | Default | Notes |
|---|---|---|
| `roots` | `Desktop\opencode projeler` | approved folders |
| `readOnly` | `false` | switches writing, deleting and commands off |
| `allowExec` | `true` | the command tool |
| `autoApprove.write` / `.exec` | `false` | skip the panel for these |
| `approvalTimeoutMs` | `110000` | how long a request waits |
| `tunnel` | `auto` | `auto`, `cloudflared`, `ngrok`, `tailscale`, `localhostrun`, `serveo` or `none` |
| `publicUrl` | empty | your own HTTPS address when `tunnel: none`, for example a Tailscale Funnel |
| `publicPort` / `panelPort` | `8857` / `8858` | ports for MCP and the panel |
| `maxOutputBytes` / `execTimeoutMs` | `200000` / `120000` | output cap and command timeout |

`auto` tries Tailscale Funnel (if you are signed in), then cloudflared,
localhost.run and Serveo, and finally ngrok. If one provider fails, the next one
is tried, and the panel shows what went wrong.

To use ngrok, add your account token once:

```bash
ngrok config add-authtoken <token>
```

## Troubleshooting

- **The tunnel address changes on every restart** with quick tunnels, so you have
  to paste it into claude.ai again. Use a fixed ngrok domain or set `publicUrl` for
  an address that stays put.
- **"session not found":** the server restarted and dropped the old MCP session.
  claude.ai usually reconnects on its own; if not, toggle the connector off and on
  in the chat.
- **The panel says "Panel key required":** open it through the `.../#k=...` address
  the server printed in the console.

## Verify

```bash
npm run verify
```

This checks the syntax and runs 14 end-to-end tests. They connect with the official
MCP SDK client and cover approval, denial, timeout, root escape through a junction,
read-only mode, and the panel guards.

## Disclaimer

This project is not affiliated with, endorsed by or verified by Anthropic. It uses
the custom connector feature that Anthropic documents for remote MCP servers, so
Claude connects to the server from Anthropic's cloud. The project does not automate
the claude.ai interface or reuse your account credentials. This is an early build
(0.1.x) and things may break.

Running it gives a language model access to files and shell commands on your
computer. A web page, document or file that Claude reads can carry prompt injection
that tries to turn those tools against you, so keep the approved roots narrow and
read each approval request before you accept it. You are responsible for the files
it reads and the commands it runs, and you should only use it on machines and data
you own or are allowed to access.

The software comes with no warranty, as stated in the LICENSE, and you use it at
your own risk.

## License

MIT. See [LICENSE](LICENSE).
