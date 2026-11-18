import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'gitea-pr',
  component: 'Pane',
  requestId: 'gitea-pr',
  props: {
    title: 'Gitea PR',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const PR = {
  number: 9,
  title: 'Add a login page',
  state: 'open',
  draft: false,
  mergeable: true,
  base: 'master',
  head: 'feature/login',
  headSha: 'abc',
  url: 'https://git.example.test/o/r/pulls/9',
  author: 'me',
  comments: 2,
  reviewDecision: '',
  reviews: [{ author: 'claude-review', state: 'COMMENT', stale: false }],
}

const out = (exitCode: number, stdout: string, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})
const OPEN_CMD = {
  command: 'gitea-pr',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

const CHECKS = [
  { name: 'review', state: 'success', url: 'https://git.example.test/run/1', description: 'ok' },
  { name: 'build', state: 'pending', url: 'https://git.example.test/run/2', description: '' },
]

test('the pane shows the branch PR with its checks', async ($, on) => {
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'gitea-pr' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', (_, e) => {
    const argv = e.argv as readonly string[]
    if (argv[0] === 'git') return out(0, 'feature/login\n')
    if (argv[2] === 'view') return out(0, JSON.stringify(PR))
    if (argv[2] === 'checks') return out(8, JSON.stringify(CHECKS))
    return out(1, '', 'unexpected')
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(OPEN_CMD)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /1 pending, 1 passed/ }))?.text).toBe('1 pending, 1 passed')
    expect(await ui.find({ key: 'merge' })).toBeTruthy()
    const title = await ui.find({ type: 'Link', text: /Add a login page/ })
    expect(title?.props.href).toBe(PR.url)
    expect(await ui.find({ type: 'Link', text: /Open in Gitea/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a branch with no PR says so', async ($, on) => {
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'gitea-pr' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', (_, e) => {
    const argv = e.argv as readonly string[]
    if (argv[0] === 'git') return out(0, 'master\n')
    return out(1, '', 'Error: no open pull request for branch "master" in o/r')
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(OPEN_CMD)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /No pull request/ }))?.text).toBe('No pull request for master.')
  await ui.unmount()
})

test('the session keeps its PR once the checkout is detached', async ($, on) => {
  let branch = 'feature/login'
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'gitea-pr' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', (_, e) => {
    const argv = e.argv as readonly string[]
    if (argv[0] === 'git') return out(0, `${branch}\n`)
    if (argv[2] === 'view' && argv[3] === '9') return out(0, JSON.stringify(PR))
    if (argv[2] === 'view') {
      return branch === 'feature/login'
        ? out(0, JSON.stringify(PR))
        : out(1, '', `Error: no open pull request for branch "${branch}" in o/r`)
    }
    if (argv[2] === 'checks') return out(0, JSON.stringify(CHECKS.slice(0, 1)))
    return out(1, '', 'unexpected')
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(OPEN_CMD)
  branch = 'HEAD'
  await $.command.run(OPEN_CMD)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /All 1 checks passed/ }))?.text).toBe('All 1 checks passed')
  await ui.unmount()
})

// The session's folder is a checkout on another branch with its own PR (#18,
// merged), while the work happens in a worktree whose PR is #9.
function twoPrs(on: Parameters<TestBody>[1]) {
  const OTHER = { ...PR, number: 18, title: 'Remove a package', state: 'merged', head: 'cipri/packages', url: 'https://git.example.test/o/r/pulls/18' }
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'gitea-pr' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', (_, e) => {
    const argv = e.argv as readonly string[]
    if (argv[0] === 'git') return out(0, 'cipri/packages\n')
    if (argv[2] === 'view' && argv[3] === '9') return out(0, JSON.stringify(PR))
    if (argv[2] === 'view') return out(0, JSON.stringify(OTHER))
    if (argv[2] === 'checks') return out(0, JSON.stringify(CHECKS.slice(0, 1)))
    return out(1, '', 'unexpected')
  })
}

const title = async (surface: 'terminal' | 'desktop', $: Parameters<TestBody>[0]) => {
  const ui = await $.ui.mount({ ...PANE, surface })
  const link = await ui.find({ type: 'Link', text: /./ })
  await ui.unmount()
  return link?.props.href
}

test('a push from a worktree pins its PR over the folder branch PR', async ($, on) => {
  twoPrs(on)
  on('tool.call', () => ({
    result: {
      stdout: '',
      stderr:
        'remote: \nremote: Visit the existing pull request:\nremote:   https://git.example.test/o/r/pulls/9\nremote: \nTo git.example.test:o/r.git\n   abc..def  feature/login -> feature/login\n',
      interrupted: false,
    },
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(OPEN_CMD)
  expect(await title('desktop', $)).toBe('https://git.example.test/o/r/pulls/18')

  await $.tool.call({ tool: 'Bash', command: 'cd .claude/worktrees/pool-1 && git push' })
  await $.command.run(OPEN_CMD)
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await title(surface, $)).toBe(PR.url)
  }
})

test('gt pr create pins the new PR, and /gitea-pr <number> pins another', async ($, on) => {
  twoPrs(on)
  on('tool.call', () => ({
    result: { stdout: 'Created pull request #9\nhttps://git.example.test/o/r/pulls/9\n', stderr: '', interrupted: false },
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'gt pr create --title x --body y' })
  await $.command.run(OPEN_CMD)
  expect(await title('desktop', $)).toBe(PR.url)

  await $.command.run({ ...OPEN_CMD, args: '18' })
  expect(await title('desktop', $)).toBe('https://git.example.test/o/r/pulls/18')
})

test('a command linking to several PRs pins none', async ($, on) => {
  twoPrs(on)
  on('tool.call', () => ({
    result: { stdout: 'https://git.example.test/o/r/pulls/9\nhttps://git.example.test/o/r/pulls/7\n', stderr: '', interrupted: false },
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git push' })
  await $.command.run(OPEN_CMD)
  expect(await title('desktop', $)).toBe('https://git.example.test/o/r/pulls/18')
})

test('git -C pushes pin too, and a link to open a new PR does not', async ($, on) => {
  let stderr = 'remote: Create a new pull request for \'feature/login\':\nremote:   https://git.example.test/o/r/pulls/new/feature/login\n'
  twoPrs(on)
  on('tool.call', () => ({ result: { stdout: '', stderr, interrupted: false } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git -C .claude/worktrees/pool-1 push -u origin HEAD' })
  await $.command.run(OPEN_CMD)
  expect(await title('desktop', $)).toBe('https://git.example.test/o/r/pulls/18')

  stderr = 'remote: Visit the existing pull request:\nremote:   https://git.example.test/o/r/pulls/9\n'
  await $.tool.call({ tool: 'Bash', command: 'git -C .claude/worktrees/pool-1 push' })
  await $.command.run(OPEN_CMD)
  expect(await title('desktop', $)).toBe(PR.url)
})

test('the pane follows the worktree Claude works in, and the folder once it is gone', async ($, on) => {
  const SLOT = '/repo/.claude/worktrees/pool-1'
  const OTHER = { ...PR, number: 18, title: 'Remove a package', head: 'cipri/packages', url: 'https://git.example.test/o/r/pulls/18' }
  let slotExists = true
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'gitea-pr' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('tool.call', () => ({ result: { stdout: 'On branch feature/login\n', stderr: '', interrupted: false } }))
  on('process.run', (_, e) => {
    const argv = e.argv as readonly string[]
    const cwd = e.init?.cwd ?? ''
    const inSlot = cwd.startsWith(SLOT)
    if (inSlot && !slotExists) return out(128, '', 'fatal: not a git repository')
    if (argv[0] === 'git' && argv.includes('--git-common-dir')) {
      return out(0, `${inSlot ? SLOT : cwd.startsWith('/repo') ? '/repo' : cwd}\n/repo/.git\n`)
    }
    if (argv[0] === 'git') return out(0, inSlot ? 'feature/login\n' : 'cipri/packages\n')
    if (argv[2] === 'view') return out(0, JSON.stringify(argv[3] === 'feature/login' || argv[3] === '9' ? PR : OTHER))
    if (argv[2] === 'checks') return out(0, JSON.stringify(CHECKS.slice(0, 1)))
    return out(1, '', 'unexpected')
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(OPEN_CMD)
  expect(await title('desktop', $)).toBe('https://git.example.test/o/r/pulls/18')

  await $.tool.call({ tool: 'Bash', command: 'cd .claude/worktrees/pool-1 && git status' })
  await $.command.run(OPEN_CMD)
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await title(surface, $)).toBe(PR.url)
  }

  // Going back to the session's own folder for one command keeps the worktree.
  await $.tool.call({ tool: 'Bash', command: 'cd /repo && gt run list' })
  await $.command.run(OPEN_CMD)
  expect(await title('desktop', $)).toBe(PR.url)

  slotExists = false
  await $.command.run(OPEN_CMD)
  expect(await title('desktop', $)).toBe(PR.url) // the session's last PR stays on show

  // Claude switching branch in the session's own folder brings the pane back there.
  slotExists = true
  await $.tool.call({ tool: 'Bash', command: 'git switch cipri/packages' })
  await $.command.run(OPEN_CMD)
  expect(await title('desktop', $)).toBe('https://git.example.test/o/r/pulls/18')
})
