# Playwriter — Browser Automation Setup & Usage Guide

> **What this is:** Drop this file into any Claude Code project. Claude Code reads it and gains the ability to install, configure, and use Playwriter to control your Chrome browser — taking screenshots, clicking buttons, filling forms, navigating pages, and more.

---

## What is Playwriter?

Playwriter lets Claude Code control a real Chrome tab on your machine. No headless browser, no separate Chrome instance — it works with your actual browser session, cookies, logins, and all. Claude Code can:

- Navigate to any URL
- Take screenshots of what's on screen
- Click buttons, links, and elements
- Fill in forms and text fields
- Read page content and accessibility trees
- Scroll, wait, and interact like a human would

---

## Prerequisites

Before Claude Code can set this up, you need TWO things installed manually:

### 1. Node.js
Check if you have it by opening your terminal (Terminal → New Terminal in VS Code) and running:
```
node -v
```
If you see a version number, you're good. If you see "command not found":
- Go to https://nodejs.org
- Download the **LTS** version
- Run the installer (keep clicking Continue/Next)
- **Quit and reopen VS Code** after installing

### 2. Playwriter Chrome Extension
- Open Chrome
- Go to the Chrome Web Store and search **"Playwriter"**
- Click **Add to Chrome**
- Click the **puzzle piece icon** in Chrome's toolbar and **pin** Playwriter so it's always visible

**That's it.** Once those two things are done, tell Claude Code: **"Set up Playwriter for me"** and it will handle the rest.

---

## Installation (Claude Code does this)

When asked to set up Playwriter, run these commands:

```bash
# Install the Playwriter CLI globally
sudo npm i -g playwriter

# Fix npm permissions if needed
sudo chown -R $(whoami) ~/.npm

# Install the Playwriter skill for Claude Code
npx -y skills add remorses/playwriter
# When prompted: select Claude Code → Global → Symlink (Recommended)
```

After installation, verify it works:
```bash
playwriter --version
```

---

## Starting a Session

**Every time** you want Claude Code to control the browser, two things must be true:

### Step 1: Start a CLI session
In a VS Code terminal (NOT the Claude Code panel — a regular terminal), run:
```bash
playwriter session new
```
This outputs a session ID (like `1` or `2`). Keep this terminal open.

### Step 2: Activate the Chrome extension
1. Navigate to a real webpage in Chrome (not a blank tab, not chrome:// pages)
2. Click the Playwriter extension icon in the toolbar
3. Wait for it to turn **green**

**Icon states:**
- ⬛ Black/Gray = not connected
- 🟠 Orange with "..." = trying to connect (CLI session probably not running)
- 🟢 Green = connected and ready

If it won't turn green:
- Make sure `playwriter session new` is running in a terminal
- Make sure you're on a real website (not chrome://, not the new tab page)
- Try refreshing the page, then clicking the icon again

---

## Usage Reference

Once connected, Claude Code can run Playwriter commands. Here's the full toolkit:

### Navigate to a URL
```bash
playwriter -s 1 -e "await page.goto('https://example.com')"
```

### Take a screenshot
```bash
playwriter -s 1 -e "await page.screenshot({ path: 'screenshot.png' })"
```

### Get the page's accessibility tree (see all interactive elements)
```bash
playwriter -s 1 -e "console.log(await snapshot({ page }))"
```
This returns a structured view of the page with `aria-ref` IDs for every clickable element, input field, link, etc. Use these refs to interact with specific elements.

### Click an element by its accessibility ref
```bash
playwriter -s 1 -e "await page.locator('aria-ref=e5').click()"
```

### Click by text content
```bash
playwriter -s 1 -e "await page.getByText('Sign In').click()"
```

### Click by role
```bash
playwriter -s 1 -e "await page.getByRole('button', { name: 'Submit' }).click()"
```

### Type into a field
```bash
playwriter -s 1 -e "await page.locator('aria-ref=e12').fill('hello@example.com')"
```

### Type by placeholder
```bash
playwriter -s 1 -e "await page.getByPlaceholder('Email').fill('hello@example.com')"
```

### Press a key
```bash
playwriter -s 1 -e "await page.keyboard.press('Enter')"
```

### Scroll down
```bash
playwriter -s 1 -e "await page.mouse.wheel(0, 500)"
```

### Wait for something to appear
```bash
playwriter -s 1 -e "await page.waitForSelector('text=Success')"
```

### Get page title
```bash
playwriter -s 1 -e "console.log(await page.title())"
```

### Get page URL
```bash
playwriter -s 1 -e "console.log(page.url())"
```

### Get text content from an element
```bash
playwriter -s 1 -e "console.log(await page.locator('.price').textContent())"
```

### Wait for page to fully load
```bash
playwriter -s 1 -e "await page.waitForLoadState('networkidle')"
```

### Go back / forward
```bash
playwriter -s 1 -e "await page.goBack()"
playwriter -s 1 -e "await page.goForward()"
```

### Select from a dropdown
```bash
playwriter -s 1 -e "await page.selectOption('select#country', 'US')"
```

### Check/uncheck a checkbox
```bash
playwriter -s 1 -e "await page.locator('aria-ref=e8').check()"
playwriter -s 1 -e "await page.locator('aria-ref=e8').uncheck()"
```

### Hover over an element
```bash
playwriter -s 1 -e "await page.locator('aria-ref=e3').hover()"
```

---

## Common Workflows

### Screenshot → Analyze → Act
The standard pattern for Claude Code browser automation:
1. Take a screenshot to see the current state
2. Get the accessibility tree to find interactive elements
3. Click/type/interact based on what's found
4. Screenshot again to verify the result

### Navigating a logged-in site
Since Playwriter uses your actual Chrome session, you're already logged into everything. Just navigate to the URL and interact — no need to handle login flows.

### Filling out a multi-step form
1. `snapshot` the page to find all fields
2. `fill` each field by its aria-ref
3. Click the submit/next button
4. `waitForLoadState` or `waitForSelector` for the next page
5. Repeat

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Extension won't turn green | Run `playwriter session new` in a terminal first |
| "command not found: playwriter" | Run `sudo npm i -g playwriter` |
| "command not found: npm" | Install Node.js from https://nodejs.org, restart VS Code |
| Extension turns orange with "..." | CLI session isn't running — run `playwriter session new` |
| Session stopped working mid-task | Run `playwriter session new` again, re-click extension icon |
| Permission errors on npm install | Run `sudo chown -R $(whoami) ~/.npm` then retry |
| Claude Code says it can't control browsers | The Playwriter skill isn't installed — run `npx -y skills add remorses/playwriter` |
| Extension icon is red with "!" | Error occurred — refresh the page, restart session |
| Wrong tab being controlled | Click the extension icon on the specific tab you want controlled |

---

## Important Notes

- **Keep the terminal open.** The `playwriter session new` terminal must stay open while you're using it. If you close it, the session dies.
- **One tab at a time.** The extension connects to whichever tab you clicked it on. To switch tabs, click the extension icon on the new tab.
- **Privacy:** Everything runs locally. No data is sent to external servers.
- **Session numbers matter.** If you've created multiple sessions, use the right `-s` number. Check which sessions exist with `playwriter session list`.
- **The extension needs a real page.** It won't activate on `chrome://` pages, the Chrome Web Store, or blank new tabs.
