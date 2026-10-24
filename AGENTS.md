# Notes for AI assistants

You are helping a person install and run Claude On Steroids on their own computer. Read this before you run anything. The README has the same facts in shorter form.

## What it is

A local MCP server that claude.ai reaches as a custom connector through the person's own Cloudflare relay. It gives Claude file and shell tools with no folder limit and no approval step. A local panel shows every call.

## Ground rules

- Do not edit anything in `app/`. The license forbids changes, and the person needs the code as published.
- Never paste the connector URL, the panel URL with its `#k=` key, or anything from `config.json` into a chat, an issue or a log. They work like passwords. If one leaks, the person presses "Rotate address" in the panel.
- Do not sign in to Cloudflare or claude.ai for the person, and do not type passwords. Tell them what to click.
- Do not delete `~/.claude-on-steroids`. It holds the secret and the permanent address, and deleting it means setting up the relay and the connector again.

## Install and run

Use the folder for the person's system, in this order.

| System | First time | Start | Stop |
| --- | --- | --- | --- |
| Windows | `For-Windows\setup.bat` | `For-Windows\start.bat` | `For-Windows\stop.bat` |
| macOS | `For-macOS/setup.command` | `For-macOS/start.command` | `For-macOS/stop.command` |
| Linux | `bash For-Linux/setup.sh` | `bash For-Linux/start.sh` | `bash For-Linux/stop.sh` |

On macOS, run `chmod +x For-macOS/*.command` once first. Setup installs Node.js, or updates it to the newest patched release from nodejs.org. Run it again after a Node.js security release. Start runs the server in its own window and opens the panel. Closing that window stops the server.

## Connect claude.ai

1. In the panel, the person presses "Get a permanent address", signs in to Cloudflare in the browser and presses Allow.
2. They press "Copy URL" when the badge says Permanent.
3. In claude.ai they open Settings > Connectors, switch to the Yours tab and press "Add custom connector".
4. They give it a name, paste the URL and choose "No sign-in" under Authentication. claude.ai warns that anyone with the URL can use it. That is expected, because the URL holds the secret.
5. They press Add, then Connect next to the new connector.
6. Under Tool permissions they set both groups to "Always allow", so Claude does not stop before every call.

The panel switches to "claude.ai connected" after the first call. The "How to connect" button in the panel shows the same steps.

## Where things are

| What | Where |
| --- | --- |
| MCP server | `127.0.0.1:8867` |
| Panel | `127.0.0.1:8868`, the full URL is printed in the start window |
| Settings, secret, panel key | `~/.claude-on-steroids/config.json`, also changed from the panel |
| Call history | `~/.claude-on-steroids/calls.jsonl` |

The server prints its status in the start window. There is no separate log file.

## Common problems

- Port 8867 is already in use. Another program or an older copy of the server holds it. Run the stop file, then start again.
- The panel says it needs a key. Open the panel URL printed in the start window, not the bare address.
- claude.ai says the connector is unavailable. The server is not running or the relay is offline. Start the server and check the panel.
- claude.ai shows "session not found". The server restarted. Turn the connector off and on again in the chat.
- A tool is missing in claude.ai. Turn the connector off and on, and if that does not help, remove it and add it again.
