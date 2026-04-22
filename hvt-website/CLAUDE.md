# HVT Website — Claude Code Instructions

## Always-on behaviors (no need to ask each time)

- **Scraping:** Always use Jina Reader (`https://r.jina.ai/[URL]`) via WebFetch to pull copy from any website. Never use raw WebFetch directly on a site.
- **Playwriter sessions:** Session 1 is the default. Run commands with `playwriter -s 1 -e "..."`. PATH is `$HOME/.npm-global/bin`.
- **Tool confirmations:** Proceed with file edits, reads, and Bash commands without asking for confirmation on routine tasks. Only pause for destructive or irreversible actions (deleting files, pushing to remote, etc.).
- **Git:** Do not commit unless explicitly asked.
- **Formatting:** No emojis. Concise responses. Skip summaries of what was just done unless asked.

## Project context

- Stack: Pure HTML / CSS / JS — no framework, no build tool.
- Files: `index.html`, `styles.css`, `script.js` in `/Users/sebastianpazmino/Developer/HVT website/`
- Design: Black background (`#000000`), blue accent (`#0055fe`), liquid glass UI, animated deep blue gradient in hero.
- Playwriter CLI installed at `~/.npm-global/bin/playwriter`.

## Playwriter quick-start (each new session)

1. Open a VS Code terminal and run: `playwriter session new`
2. Click the Playwriter extension icon in Brave/Chrome → wait for green
3. Default session ID is `1`
