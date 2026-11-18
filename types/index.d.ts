export type GiteaCheck = {
  name: string
  /** Gitea commit status: pending, success, error, failure, warning (or skipped). */
  state: string
  url: string
  description: string
}

export type GiteaReview = {
  author: string
  /** APPROVED, REQUEST_CHANGES, COMMENT, PENDING. */
  state: string
  stale: boolean
}

export type GiteaPr = {
  number: number
  title: string
  /** open, closed or merged. */
  state: string
  draft: boolean
  mergeable: boolean
  base: string
  head: string
  headSha: string
  url: string
  author: string
  comments: number
  /** approved, changes_requested, review_required or empty. */
  reviewDecision: string
  reviews: GiteaReview[]
}

export type GiteaPrView =
  | { kind: 'loading' }
  | { kind: 'none'; branch: string; reason: string }
  | { kind: 'error'; branch: string; message: string }
  | {
      kind: 'pr'
      branch: string
      pr: GiteaPr
      checks: GiteaCheck[]
      fetchedAt: number
    }

export type GiteaMerge =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'running' }
  | { kind: 'failed'; message: string }

declare module 'claude-code' {
  interface PluginState {
    'gitea-pr': {
      view: Shaped<GiteaPrView>
      merge: Shaped<GiteaMerge>
      /** The PR number the pane last opened itself for (0: none). */
      autoOpened: Shaped<number>
      /** The branch and PR number last seen, so a merged PR stays on show. */
      lastSeen: Shaped<{ branch: string; number: number }>
      /** The other worktree of the session's repository Claude last worked in ('' for none). */
      workDir: Shaped<string>
      /**
       * The session's own PR (0: none): the one Claude opened or pushed to, or
       * the one `/gitea-pr <number>` named. Shown before the checkout's branch.
       */
      pinned: Shaped<{ number: number; url: string }>
    }
  }
}
