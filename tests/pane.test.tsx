import { expect, mock, test } from 'claude-code/testing'

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
