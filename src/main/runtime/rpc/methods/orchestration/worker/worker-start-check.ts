import { runProcess } from '@orca/process-host'
import { realpathSync } from 'node:fs'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'

const CHECK_TIMEOUT_MS = 5_000

export async function assertLocalWorkerStartCheck(
  runtime: OrcaRuntimeService,
  repoSelector: string | undefined,
  worktree: { repoId: string; hostId?: string | null; path: string } | undefined,
  spec: string
): Promise<void> {
  const policyText = process.env.ORCA_WORKER_START_CHECKS
  if (!policyText) {
    return
  }
  const repos = runtime.listRepos()
  const repo = worktree
    ? repos.find(
        (candidate) =>
          candidate.id === worktree.repoId &&
          getRepoExecutionHostId(candidate) === (worktree.hostId ?? 'local')
      )
    : repoSelector
      ? await runtime.showRepo(repoSelector)
      : undefined
  if (!repo) {
    throw new OrchestrationError(
      'worker_start_check_unverifiable',
      'The dispatch repository could not be identified before worker creation.',
      { effectsApplied: false }
    )
  }
  let configuredCommand: unknown
  try {
    const policies: unknown = JSON.parse(policyText)
    if (!policies || typeof policies !== 'object' || Array.isArray(policies)) {
      throw new Error('worker-start check map must be an object')
    }
    const path = getRepoExecutionHostId(repo) === 'local' ? realpathSync(repo.path) : repo.path
    configuredCommand = Object.getOwnPropertyDescriptor(policies, path)?.value
  } catch (error) {
    throw new OrchestrationError(
      'worker_start_check_unverifiable',
      `Repository worker-start policy could not be read: ${String(error)}`,
      { effectsApplied: false }
    )
  }
  if (configuredCommand === undefined) {
    return
  }
  if (getRepoExecutionHostId(repo) !== 'local') {
    throw new OrchestrationError(
      'worker_start_check_unverifiable',
      'Worker-start checks for SSH-hosted repositories are not supported.',
      { effectsApplied: false }
    )
  }
  if (typeof configuredCommand !== 'string' || !configuredCommand.trim()) {
    throw new OrchestrationError(
      'worker_start_check_unverifiable',
      'Repository worker-start policy has no command.',
      { effectsApplied: false }
    )
  }
  await assertWorkerStartCheck({
    command: configuredCommand,
    cwd: worktree?.path ?? repo.path,
    spec
  })
}

/** Run only a command explicitly configured by this host. */
export async function assertWorkerStartCheck(args: {
  command: string
  cwd: string
  spec: string
}): Promise<void> {
  const command = args.command.trim()
  let result: Awaited<ReturnType<typeof runProcess>>
  try {
    result = await runProcess({
      program: process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/bash',
      args: process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command],
      cwd: args.cwd,
      input: args.spec,
      timeoutMs: CHECK_TIMEOUT_MS,
      maxOutputBytes: 8_192,
      killOnOutputLimit: true,
      terminationBarrier: true
    })
  } catch (error) {
    throw new OrchestrationError(
      'worker_start_check_failed',
      `Repository worker-start check could not run: ${String(error)}`,
      { effectsApplied: false }
    )
  }
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    const reason = result.timedOut
      ? 'timed out'
      : result.outputTruncated
        ? 'output exceeded limit'
        : `exited ${result.code ?? 'without a status'}`
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 1_000)
    throw new OrchestrationError(
      'worker_start_check_failed',
      `Repository worker-start check ${reason}${detail ? `: ${detail}` : ''}`,
      { effectsApplied: false }
    )
  }
}
