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

// gt may not be on the PATH the app hands the session.
const GT_CANDIDATES = ['gt', '/opt/homebrew/bin/gt', '/usr/local/bin/gt']
const PR_FIELDS =
  'number,title,state,draft,merged,mergeable,base,head,head_sha,url,author,comments,review_decision,reviews'
const PR_JQ =
  '{number, title, state: (if .merged then "merged" else .state end), draft, mergeable, base, head,' +
  ' headSha: .head_sha, url, author, comments, reviewDecision: (.review_decision // ""),' +
  ' reviews: [(.reviews // [])[] | {author, state, stale}]}'
// Bash commands after which the PR likely changed.
const TRIGGER = /\b(git\s+(push|checkout|switch|pull|merge|rebase|reset)|gt\s+(pr|api))\b/

let gtPath: string | undefined
let running: Promise<void> | undefined
let tick = 0

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

// One lookup at a time: a refresh asked while one runs waits for that one.
function refresh($: EngineInterface): Promise<void> {
  running ??= lookUp($).finally(() => {
    running = undefined
  })
  return running
}

async function lookUp($: EngineInterface) {
  try {
    const cwd = await $.session.cwd()
    const head = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeoutMs: 5000,
    })
    if (head.exitCode !== 0) {
      await setView($, { kind: 'none', branch: '', reason: 'This folder is not a git repository.' })
      return
    }
    const branch = head.stdout.trim()
    const isDetached = branch === 'HEAD'

    let found: Awaited<ReturnType<typeof fetchPr>> = isDetached
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
      const isNone = /no open pull request|repository required|not a gitea|no gitea|unknown host|no login/i.test(
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
    const cwd = await $.session.cwd()
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
      description: 'Show the Gitea pull request of the current branch in a pane',
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

  on('command.run', { command: 'gitea-pr' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await refresh($)
    return { text: 'Gitea PR pane opened.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (TRIGGER.test(e.command)) void refresh($)
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
              <Text color="text" bold>
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
