# Claude On Steroids ✴️

> [!NOTE]
> This project uses Anthropic's official custom connector feature for claude.ai. It follows Anthropic's rules and should not get your account banned.
>
> Everything runs on your computer and on your own Cloudflare account. I have no server and I don't collect data. Claude sees a file only when it reads it in your chat.
> 
> **Please read this document carefully to set correctly.**

A custom MCP connector that lets normal Claude chat work on your own computer. It can read and search files, write, edit and delete them, and run shell commands.

Every call runs right away with your user's rights, on any folder your account can reach.
A local panel shows each call as it happens.

<p align="center"><img src="screenshots/claude-chat.png" alt="Claude creates a folder and a story file on the Desktop through the connector" width="760"></p>

![The local panel](screenshots/panel.png)

claude.ai reaches the server over a small relay on your own free Cloudflare account, so the connector URL never changes. There is no browser extension and no chat scraping.

## Getting started

Open the folder for your system and use its three files.

| Folder | First time | Start | Stop |
| --- | --- | --- | --- |
| `For-Windows` | `setup.bat` | `start.bat` | `stop.bat` |
| `For-macOS` | `setup.command` | `start.command` | `stop.command` |
| `For-Linux` | `bash setup.sh` | `bash start.sh` | `bash stop.sh` |

Setup installs Node.js, or updates it to the newest patched release from nodejs.org, then the packages the project needs. Run it again any time to pick up Node.js security releases. "How to connect" guide at web page walks you through the permanent address and adding the connector in claude.ai. Closing the start window also stops the server.

On a Mac, run `chmod +x For-macOS/*.command` once in Terminal first, because the files on GitHub do not carry their run permission. If macOS blocks a file, right click it and choose Open.

## Tool permissions in claude.ai

claude.ai has its own tool permissions for each connector. Set both tool groups to "Always allow" there, so Claude does not stop before every call. The connector itself asks nothing and has no folder limit. A path without a folder starts from your home folder.

## Tools

| Tool | What it does |
| --- | --- |
| `machine_info` | show the computer, its shell and the home folder |
| `list_dir`, `read_file`, `search` | read and search |
| `write_file`, `edit_file` | change files |
| `delete_file` | delete a file or folder |
| `exec_command` | run a shell command |

## Security

- The connector URL contains a secret, so treat it like a password. If it leaks, press "Rotate address" and paste the new URL into claude.ai.
- Anyone with the URL can read, change and delete your files and run commands as your user, with nothing to stop them.
- A file or web page Claude reads can hide instructions aimed at these tools. Nothing waits for your approval, so watch the Activity board.
- The panel listens on `127.0.0.1` only, needs the key in its URL and turns away requests from other sites.
- The relay runs in your own Cloudflare account and stores only a hash of the secret.

## License

PolyForm Strict 1.0.0. See [LICENSE.md](LICENSE.md). You may download and use the software for personal and other noncommercial purposes. You may not change it, build on it, share copies of it, sell it or use it commercially.

## About

Some parts of this project were made with help from AI tools. I guided and checked all of the work and made every final decision.
