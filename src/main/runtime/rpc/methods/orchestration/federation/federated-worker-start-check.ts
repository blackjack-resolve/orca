import type { RuntimeStatus } from '../../../../../../shared/runtime-types'
import { ORCHESTRATION_WORKER_START_CHECK_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { WorkerStartInput } from '../worker/worker-start-schema'
import { ORCHESTRATION_CONTRACT_PREFLIGHT_TIMEOUT_MS } from '../../../../../../shared/orchestration-timing-budgets'

export async function assertFederatedWorkerStartCheck(args: {
  runtime: OrcaRuntimeService
  server: ReturnType<OrcaRuntimeService['resolveOrchestrationWorkerServer']>
  status: RuntimeStatus
  params: WorkerStartInput
  taskSpec: string
}): Promise<void> {
  const { runtime, server, status, params, taskSpec } = args
  if (!status.capabilities?.includes(ORCHESTRATION_WORKER_START_CHECK_RUNTIME_CAPABILITY)) {
    // Older servers cannot store a workerStart policy, so their existing policy-free route remains valid.
    return
  }
  const preflight: unknown = await runtime.callOrchestrationWorkerServer(
    server.environmentId,
    'orchestration.federationWorkerStartCheck',
    { taskSpec, worktree: params.worktree, repo: params.repo },
    // The host checker may use its full 5s budget; leave another 5s for transport and response.
    2 * ORCHESTRATION_CONTRACT_PREFLIGHT_TIMEOUT_MS,
    undefined,
    { contractVerified: true, expectedEnvironmentPairingRevision: server.pairingRevision }
  )
  if (
    !preflight ||
    typeof preflight !== 'object' ||
    !('status' in preflight) ||
    preflight.status !== 'passed'
  ) {
    throw new OrchestrationError(
      'worker_start_check_unverifiable',
      'The worker server did not confirm its pre-dispatch brief check.',
      { effectsApplied: false }
    )
  }
}
