# gitea-pr

A Claude Code mod that shows the [Gitea](https://about.gitea.com) pull request of your current branch in a pane beside the chat. It does for Gitea what Claude Code's built-in PR pane does for GitHub.

The pane shows:

- the PR's title (a link to it in Gitea), number and state (open, draft, merged, closed) and which branch merges into which
- each CI check (Gitea Actions or any commit status) with a link to its run, and a summary line
- the review decision and each reviewer's latest review, plus the comment count
- whether it merges without conflicts
- **Refresh** and **Merge…** (asks you to confirm, and merges only if nobody pushed since the pane loaded the PR)

Minimized to a widget on the desktop app, it shows one line: title, state and checks.

It opens by itself when your branch has an open PR, and stays closed for that PR once you close it. `/gitea-pr` opens it any time. After a merge it keeps showing the PR as merged.

It refreshes when the session starts, every minute (every 15 seconds while checks are running), and right after Claude runs `git push`, `git checkout`, `gt pr …` and similar commands.

## Requirements

- [`gt`](https://gitea.com/gitea/cli), the official Gitea CLI, version 1.2 or newer, signed in to your Gitea instance (`gt auth login`). The mod looks for it on `PATH`, then in `/opt/homebrew/bin` and `/usr/local/bin`.
- A repository whose remote is on that Gitea instance.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install gitea-pr --marketplace gavrilovici/gitea-pr
```

Answer `y` to add the marketplace, then pick a scope (user is the usual one).

From a shell:

```bash
claude plugin install gitea-pr --marketplace gavrilovici/gitea-pr
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `gavrilovici/gitea-pr`, then **Add plugin**.

## How it works

The mod is a hooks module (`hooks/register.tsx`), plain readable TypeScript. It draws a pane and runs these commands in the session's folder, and nothing else:

- `git rev-parse --abbrev-ref HEAD`, to read the current branch
- `gt pr view <branch or number> --json …`, to read the pull request
- `gt pr checks <number> --json …`, to read its checks
- `gt pr merge <number> --match-head-commit <sha> --no-input`, only after you press **Merge…** and then **Confirm merge**

It also watches the Bash commands Claude runs, only to notice a `git push`, `git checkout`, `gt pr …` and similar, so it can refresh. It never changes or blocks them.

### Data

- **Sent:** the mod makes no network requests itself. Every request to Gitea is one `gt` makes to the Gitea instance you signed it in to, with your own login.
- **Read:** the PR's title, branches, state, checks, reviewer names and review states, as your Gitea account can see them.
- **Kept:** only what the pane shows, in the session's own state. The mod writes no files and keeps nothing across sessions.

## License

MIT
