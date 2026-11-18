import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GiteaCheck, GiteaMerge, GiteaPr, GiteaPrView } from '../types'

const PANE = 'gitea-pr'
const TITLE = 'Gitea PR'

const view = atom({ plugin: 'gitea-pr', key: 'view' } as const, { kind: 'loading' } as GiteaPrView, {
  shape: 'view-1',
})
const merge = atom({ plugin: 'gitea-pr', key: 'merge' } as const, { kind: 'idle' } as GiteaMerge, {
  shape: 'merge-1',
})
const autoOpened = atom({ plugin: 'gitea-pr', key: 'autoOpened' } as const, 0, {
  shape: 'auto-1',
})
const lastSeen = atom(
  { plugin: 'gitea-pr', key: 'lastSeen' } as const,
  { branch: '', number: 0 },
  { shape: 'seen-1' },
)
// The other worktree of the session's repository that Claude last worked in
// ('' for none): commands run as `cd <worktree> && …` leave the session's own
// folder where it was, on a branch that may not be the one being worked on.
const workDir = atom({ plugin: 'gitea-pr', key: 'workDir' } as const, '', { shape: 'workdir-1' })
const pinned = atom(
  { plugin: 'gitea-pr', key: 'pinned' } as const,
  { number: 0, url: '' },
  { shape: 'pin-1' },
)

// gt may not be on the PATH the app hands the session.
const GT_CANDIDATES = ['gt', '/opt/homebrew/bin/gt', '/usr/local/bin/gt']
const PR_FIELDS =
  'number,title,state,draft,merged,mergeable,base,head,head_sha,url,author,comments,review_decision,reviews'
const PR_JQ =
  '{number, title, state: (if .merged then "merged" else .state end), draft, mergeable, base, head,' +
  ' headSha: .head_sha, url, author, comments, reviewDecision: (.review_decision // ""),' +
  ' reviews: [(.reviews // [])[] | {author, state, stale}]}'
// Bash commands after which the PR likely changed.
// Options may sit between the program and its subcommand (`git -C <dir> push`).
const TRIGGER = /\b(git\b[^|;&\n]*?\b(push|checkout|switch|pull|merge|rebase|reset)|gt\b[^|;&\n]*?\b(pr|api))\b/
// Bash commands whose output names the PR the session works on: `gt pr create`
// prints the new PR's link, and Gitea answers a push to a branch that has an
// open PR with "Visit the existing pull request: <link>".
const BINDS = /\b(git\b[^|;&\n]*?\bpush|gt\b[^|;&\n]*?\bpr\s+create)\b/
const PR_URL = /https?:\/\/[^\s'"<>()[\]]+?\/pulls\/(\d+)(?!\d)/g

let gtPath: string | undefined
let running: Promise<void> | undefined
let rerun = false
let tick = 0

/** The one PR a command's output links to, if it links to exactly one. */
function prFromOutput(text: string): { number: number; url: string } | undefined {
  const found = new Map<string, number>()
  for (const m of text.matchAll(PR_URL)) found.set(m[0], Number(m[1]))
  const [only] = found
  if (found.size !== 1 || !only) return undefined
  return { number: only[1], url: only[0] }
}

function outputOf(ran: unknown): string {
  const r = ran as { result?: { stdout?: unknown; stderr?: unknown }; text?: unknown }
  const parts = [r.result?.stdout, r.result?.stderr].filter((s): s is string => typeof s === 'string')
  if (parts.length > 0) return parts.join('\n')
  return typeof r.text === 'string' ? r.text : ''
}

// Folders a command moves into: `cd <dir>`, `pushd <dir>` or `git -C <dir>`.
const DIRS = /(?:^|[;&|(]\s*)(?:cd|pushd)\s+('[^']*'|"[^"]*"|[^\s;&|)]+)|\bgit\s+-C\s+('[^']*'|"[^"]*"|[^\s;&|)]+)/g

function dirsOf(command: string): string[] {
  const dirs: string[] = []
  for (const m of command.matchAll(DIRS)) {
    const raw = m[1] ?? m[2] ?? ''
    const dir = raw.replace(/^(['"])(.*)\1$/, '$2')
    // Skip what a shell would expand: `~`, `$VAR`, `-`.
    if (dir && !/^[~$-]/.test(dir)) dirs.push(dir)
  }
  return dirs
}

/** A checkout's own folder and its repository's shared git folder, absolute. */
async function gitRoots($: EngineInterface, cwd: string) {
  try {
    const ran = await $.process.run(
      ['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
      { cwd, timeoutMs: 5000 },
    )
    const [top, common] = ran.stdout.trim().split('\n')
    return ran.exitCode === 0 && top && common ? { top, common } : undefined
  } catch {
    return undefined
  }
}

/**
 * Notes the last of a command's folders that is another worktree of the
 * session's repository; says whether that changed the folder the pane reads.
 */
async function noteWorktree($: EngineInterface, command: string): Promise<boolean> {
  const dirs = dirsOf(command)
  if (dirs.length === 0) return false
  const cwd = await $.session.cwd()
  const home = await gitRoots($, cwd)
  if (!home) return false
  for (const dir of dirs.reverse()) {
    const there = await gitRoots($, dir.startsWith('/') ? dir : `${cwd}/${dir}`)
    if (!there || there.common !== home.common || there.top === home.top) continue
    if ((await read($, workDir)) === there.top) return false
    await update($, workDir, () => there.top)
    return true
  }
  return false
}

const sameUrl = (a: string, b: string) =>
  a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase()

async function gt($: EngineInterface, args: string[], cwd: string, timeoutMs = 20000) {
  const tries = gtPath ? [gtPath] : GT_CANDIDATES
  let lastError: unknown
  for (const bin of tries) {
    try {
      const ran = await $.process.run([bin, ...args], { cwd, timeoutMs })
      gtPath = bin
      return ran
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('gt was not found')
}

async function setView($: EngineInterface, next: GiteaPrView) {
  // Skip writes that change nothing (a PR's write still moves its "Updated" time).
  const now = await read($, view)
  if (next.kind !== 'pr' && JSON.stringify(now) === JSON.stringify(next)) return
  await update($, view, () => next)
}

async function fetchPr(
  $: EngineInterface,
  ref: string,
  cwd: string,
): Promise<{ error: string } | { pr: GiteaPr }> {
  const ran = await gt($, ['pr', 'view', ref, '--json', PR_FIELDS, '--jq', PR_JQ], cwd)
  if (ran.exitCode !== 0) return { error: (ran.stderr || ran.stdout).trim() }
  return { pr: JSON.parse(ran.stdout) as GiteaPr }
}

// One lookup at a time. A refresh asked while one runs makes it look again once
// done, since what it asked for (a new pin, a push) may have come too late.
function refresh($: EngineInterface): Promise<void> {
  if (running) {
    rerun = true
    return running
  }
  running = (async () => {
    do {
      rerun = false
      await lookUp($)
    } while (rerun)
  })().finally(() => {
    running = undefined
  })
  return running
}

async function lookUp($: EngineInterface) {
  try {
    // Read in the worktree Claude works in. Once that is gone its branch is
    // unknown, as on a detached checkout, never the session folder's branch.
    let cwd = await $.session.cwd()
    const worktree = await read($, workDir)
    const head = await $.process
      .run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktree || cwd, timeoutMs: 5000 })
      .catch(() => undefined)
    const isGone = worktree !== '' && head?.exitCode !== 0
    if (worktree && !isGone) cwd = worktree
    if (!isGone && head?.exitCode !== 0) {
      await setView($, { kind: 'none', branch: '', reason: 'This folder is not a git repository.' })
      return
    }
    const branch = isGone ? '' : (head?.stdout.trim() ?? '')
    const isDetached = branch === 'HEAD'

    // The session's own PR comes first: its folder may be a checkout on some
    // other branch (the work done in a worktree), whose PR is not the session's.
    let found: Awaited<ReturnType<typeof fetchPr>> | undefined
    const pin = await read($, pinned)
    if (pin.number > 0) {
      const byPin = await fetchPr($, String(pin.number), cwd)
      // Same number, same link: the folder is in the pinned PR's repository.
      if ('pr' in byPin && sameUrl(byPin.pr.url, pin.url)) found = byPin
      if ('error' in byPin) {
        // A failed read (offline, gt timed out) keeps the pinned PR on show.
        const now = await read($, view)
        if (now.kind === 'pr' && sameUrl(now.pr.url, pin.url)) return
      }
    }
    found ??= isGone
      ? { error: `The worktree ${worktree} is gone: no branch to look up.` }
      : isDetached
        ? { error: 'Detached HEAD: no branch to look up.' }
        : await fetchPr($, branch, cwd)
    if ('error' in found) {
      // Like the GitHub pane, stay on the session's PR once there is one: gt
      // finds only open PRs by branch, and the checkout may since have moved
      // (merged, detached, switched to the base branch).
      const seen = await read($, lastSeen)
      if (seen.number > 0) {
        const again = await fetchPr($, String(seen.number), cwd)
        if ('pr' in again) found = again
      }
    }
    if ('error' in found) {
      const message = found.error.replace(/^Error:\s*/, '')
      const isNone = /no open pull request|no branch to look up|repository required|not a gitea|no gitea|unknown host|no login/i.test(
        message,
      )
      await setView(
        $,
        isNone
          ? { kind: 'none', branch, reason: message }
          : { kind: 'error', branch, message },
      )
      return
    }

    const pr = found.pr
    await update($, lastSeen, () => ({ branch: pr.head, number: pr.number }))

    let checks: GiteaCheck[] = []
    const ranChecks = await gt(
      $,
      ['pr', 'checks', String(pr.number), '--json', 'name,state,url,description'],
      cwd,
    )
    // gt exits 8 while checks are pending and 1 when one failed; the JSON is the same.
    if (ranChecks.stdout.trim().startsWith('[')) {
      checks = JSON.parse(ranChecks.stdout) as GiteaCheck[]
    }

    await setView($, { kind: 'pr', branch, pr, checks, fetchedAt: await $.clock.now() })

    if (pr.state === 'open' && (await read($, autoOpened)) !== pr.number) {
      await update($, autoOpened, () => pr.number)
      // Unasked, start small: on the desktop app a widget, which the person can
      // keep in the session rail; /gitea-pr opens the full pane.
      void $.ui.open({ id: PANE, title: `${TITLE} #${pr.number}`, placement: 'widget' })
    }
  } catch (error) {
    await setView($, {
      kind: 'error',
      branch: '',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

async function runMerge($: EngineInterface) {
  const now = await read($, view)
  if (now.kind !== 'pr') return
  await update($, merge, () => ({ kind: 'running' }) as GiteaMerge)
  try {
    const cwd = (await read($, workDir)) || (await $.session.cwd())
    const ran = await gt(
      $,
      [
        'pr',
        'merge',
        String(now.pr.number),
        '--match-head-commit',
        now.pr.headSha,
        '--no-input',
      ],
      cwd,
      60000,
    )
    if (ran.exitCode !== 0) {
      const message = (ran.stderr || ran.stdout).trim().replace(/^Error:\s*/, '')
      await update($, merge, () => ({ kind: 'failed', message }) as GiteaMerge)
    } else {
      await update($, merge, () => ({ kind: 'idle' }) as GiteaMerge)
      $.ui.toast(`Merged #${now.pr.number}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await update($, merge, () => ({ kind: 'failed', message }) as GiteaMerge)
  }
  await refresh($)
}

function checkGlyph(state: string): { glyph: string; color: string } {
  switch (state) {
    case 'success':
      return { glyph: '✓', color: 'success' }
    case 'failure':
    case 'error':
      return { glyph: '✗', color: 'error' }
    case 'pending':
    case 'running':
    case 'waiting':
      return { glyph: '●', color: 'warning' }
    case 'warning':
      return { glyph: '!', color: 'warning' }
    default:
      return { glyph: '–', color: 'inactive' }
  }
}

function prState(pr: GiteaPr): { label: string; color: string } {
  if (pr.state === 'merged') return { label: 'Merged', color: 'merged' }
  if (pr.state === 'closed') return { label: 'Closed', color: 'error' }
  if (pr.draft) return { label: 'Draft', color: 'inactive' }
  return { label: 'Open', color: 'success' }
}

function checksSummary(checks: GiteaCheck[]): { text: string; color: string } {
  if (checks.length === 0) return { text: 'No checks', color: 'inactive' }
  const failed = checks.filter(c => c.state === 'failure' || c.state === 'error').length
  const pending = checks.filter(c => ['pending', 'running', 'waiting'].includes(c.state)).length
  const passed = checks.filter(c => c.state === 'success').length
  if (failed > 0) return { text: `${failed} failing, ${passed} passed`, color: 'error' }
  if (pending > 0) return { text: `${pending} pending, ${passed} passed`, color: 'warning' }
  return { text: `All ${passed} checks passed`, color: 'success' }
}

function reviewSummary(pr: GiteaPr): { text: string; color: string } {
  switch (pr.reviewDecision) {
    case 'approved':
      return { text: 'Approved', color: 'success' }
    case 'changes_requested':
      return { text: 'Changes requested', color: 'error' }
    case 'review_required':
      return { text: 'Review required', color: 'warning' }
    default:
      return { text: 'No required reviews', color: 'inactive' }
  }
}

function latestReviews(pr: GiteaPr) {
  const byAuthor = new Map<string, string>()
  for (const r of pr.reviews) if (!r.stale || !byAuthor.has(r.author)) byAuthor.set(r.author, r.state)
  const words: Record<string, string> = {
    APPROVED: 'approved',
    REQUEST_CHANGES: 'requested changes',
    COMMENT: 'commented',
    PENDING: 'pending',
  }
  return [...byAuthor].map(([author, state]) => `${author} ${words[state] ?? state.toLowerCase()}`)
}

function clockTime(ms: number) {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

export const register: Register = on => {
  let timer: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'gitea-pr',
      description: "Show the session's Gitea pull request in a pane; a number makes it that PR",
      argumentHint: '[pr number]',
    })
    timer?.cancel()
    // Every 15 s while checks are pending or a merge runs, else every minute.
    timer = $.clock.every(15000, () => {
      tick += 1
      void (async () => {
        const now = await read($, view)
        const isBusy =
          now.kind === 'pr' &&
          now.pr.state === 'open' &&
          now.checks.some(c => ['pending', 'running', 'waiting'].includes(c.state))
        if (isBusy || tick % 4 === 0) await refresh($)
      })()
    })
    void refresh($)
    return started
  })

  on('command.run', { command: 'gitea-pr' }, async ($, e) => {
    const asked = /^#?(\d+)$/.exec(e.args.trim())?.[1]
    if (asked) {
      const found = await fetchPr($, asked, (await read($, workDir)) || (await $.session.cwd()))
      if ('error' in found) {
        return { text: `Could not read PR #${asked}: ${found.error.replace(/^Error:\s*/, '')}` }
      }
      await update($, pinned, () => ({ number: found.pr.number, url: found.pr.url }))
    }
    await $.ui.open({ id: PANE, title: TITLE })
    await refresh($)
    return { text: asked ? `Gitea PR pane opened on #${asked}.` : 'Gitea PR pane opened.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    let changed = await noteWorktree($, e.command)
    // Claude switching branch in the session's own folder works there again.
    if (/\bgit\s+(checkout|switch)\b/.test(e.command) && dirsOf(e.command).length === 0) {
      if ((await read($, workDir)) !== '') {
        await update($, workDir, () => '')
        changed = true
      }
    }
    if (BINDS.test(e.command)) {
      const pr = prFromOutput(outputOf(ran))
      if (pr) {
        await update($, pinned, () => pr)
        changed = true
      }
    }
    if (changed || TRIGGER.test(e.command)) void refresh($)
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const now = await read($, view)
    const merging = await read($, merge)
    const refreshButton = (
      <Button key="refresh" onPress={() => void refresh($)}>
        Refresh
      </Button>
    )

    if (now.kind === 'loading') return <Text dimColor>Looking up the pull request…</Text>
    if (now.kind === 'none') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text>{now.branch ? `No pull request for ${now.branch}.` : 'No pull request.'}</Text>
          <Text dimColor>{now.reason}</Text>
          <Box>{refreshButton}</Box>
        </Box>
      )
    }
    if (now.kind === 'error') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="error">Could not read the pull request.</Text>
          <Text dimColor>{now.message}</Text>
          <Box>{refreshButton}</Box>
        </Box>
      )
    }

    const { pr, checks } = now
    const state = prState(pr)
    const summary = checksSummary(checks)
    const review = reviewSummary(pr)

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          <Text bold wrap="truncate-end">
            #{pr.number} {pr.title}
          </Text>
          <Text>
            <Text color={state.color}>{state.label}</Text>
            <Text dimColor> · </Text>
            <Text color={summary.color}>{summary.text}</Text>
          </Text>
        </Box>
      )
    }

    const canMerge = pr.state === 'open' && !pr.draft && pr.mergeable
    const reviews = latestReviews(pr)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>
            <Link href={pr.url}>
              <Text color="text" bold hover={{ scope: 'pr-title', color: 'text', underline: true }}>
                {pr.title}
              </Text>
            </Link> <Text dimColor>#{pr.number}</Text>
          </Text>
          <Text>
            <Text color={state.color} bold>
              {state.label}
            </Text>
            <Text dimColor>
              {' '}
              · {pr.author} wants to merge {pr.head} into {pr.base}
            </Text>
          </Text>
        </Box>

        <Box flexDirection="column">
          <Text bold>Checks</Text>
          <Text color={summary.color}>{summary.text}</Text>
          {checks.map(c => {
            const g = checkGlyph(c.state)
            return (
              <Text>
                <Text color={g.color}>{g.glyph}</Text> <Link href={c.url} label={c.name} />
                {c.description ? <Text dimColor> {c.description}</Text> : null}
              </Text>
            )
          })}
        </Box>

        <Box flexDirection="column">
          <Text bold>Reviews</Text>
          <Text color={review.color}>{review.text}</Text>
          {reviews.map(line => (
            <Text dimColor>{line}</Text>
          ))}
          {pr.comments > 0 && (
            <Text dimColor>
              {pr.comments} comment{pr.comments === 1 ? '' : 's'}
            </Text>
          )}
        </Box>

        {pr.state === 'open' && (
          <Box flexDirection="column">
            <Text bold>Merge</Text>
            {pr.draft ? (
              <Text color="inactive">Draft: mark it ready before merging.</Text>
            ) : pr.mergeable ? (
              <Text color="success">No conflicts with {pr.base}</Text>
            ) : (
              <Text color="error">Conflicts with {pr.base}, or blocked</Text>
            )}
            {merging.kind === 'failed' && <Text color="error">Merge failed: {merging.message}</Text>}
          </Box>
        )}

        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {refreshButton}
          {canMerge && merging.kind !== 'confirm' && merging.kind !== 'running' && (
            <Button key="merge" variant="primary" onPress={() => void update($, merge, () => ({ kind: 'confirm' }) as GiteaMerge)}>
              Merge…
            </Button>
          )}
          {canMerge && merging.kind === 'confirm' && (
            <Button key="confirm" variant="primary" onPress={() => void runMerge($)}>
              Confirm merge into {pr.base}
            </Button>
          )}
          {canMerge && merging.kind === 'confirm' && (
            <Button key="cancel" onPress={() => void update($, merge, () => ({ kind: 'idle' }) as GiteaMerge)}>
              Cancel
            </Button>
          )}
          {merging.kind === 'running' && <Text dimColor>Merging…</Text>}
        </Box>

        <Text dimColor>Updated {clockTime(now.fetchedAt)}</Text>
      </Box>
    )
  })
}
