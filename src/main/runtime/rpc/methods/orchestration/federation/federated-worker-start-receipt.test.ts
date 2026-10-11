import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_START_CHECK_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { startFederatedWorker } from './federated-worker-start'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'

describe('federated worker start receipt validation', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close()
    }
  })

  it('marks a malformed ready receipt outcome unknown without persisting resources', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    databases.push(db)
    const run = db.createRun({
      objective: 'federated worker',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'remote work', runId: run.id })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_remote',
      name: 'remote',
      peerFingerprint: 'remote_peer',
      pairingRevision: 73
    })
    const remoteCall = vi
      .spyOn(runtime, 'callOrchestrationWorkerServer')
      .mockImplementation(async (_environmentId, method, params) => {
        if (method === 'status.get') {
          return {
            capabilities: [
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
              ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
              ORCHESTRATION_WORKER_START_CHECK_RUNTIME_CAPABILITY
            ]
          }
        }
        if (method === 'orchestration.federationWorkerStartCheck') {
          return { status: 'passed' }
        }
        return {
          dispatchId: (params as { dispatchId: string }).dispatchId,
          state: 'ready',
          worktreeId: 'worktree_remote',
          terminalHandle: 'term_remote'
        }
      })

    const result = (await startFederatedWorker({
      params: {
        task: task.id,
        from: 'term_coord',
        on: 'remote',
        worktree: 'id:worktree_remote',
        terminal: 'term_remote'
      },
      runtime,
      db,
      runId: run.id,
      task,
      orchestrationMutation: {
        callerFingerprint: 'caller',
        requestId: 'remote_start',
        method: 'orchestration.workerStart',
        payloadHash: 'payload'
      }
    })) as { dispatchId: string; state: string; lastError?: string }

    expect(result).toMatchObject({
      state: 'outcome_unknown',
      lastError: 'The worker server returned an invalid ready receipt.'
    })
    expect(db.getFederatedDispatch(result.dispatchId)).toMatchObject({
      remote_runtime_epoch: null,
      remote_worktree_id: null,
      remote_terminal_handle: null
    })
    for (const call of remoteCall.mock.calls) {
      expect(call[5]).toEqual({
        ...([
          'orchestration.federationAttachStart',
          'orchestration.federationWorkerStartCheck'
        ].includes(call[1])
          ? { contractVerified: true }
          : {}),
        expectedEnvironmentPairingRevision: 73
      })
    }
  })

  it('rejects a remote brief before creating a home dispatch', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    databases.push(db)
    const run = db.createRun({
      objective: 'remote check',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'BAD', runId: run.id })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_remote',
      name: 'remote',
      peerFingerprint: 'remote_peer',
      pairingRevision: 1
    })
    const remoteCall = vi
      .spyOn(runtime, 'callOrchestrationWorkerServer')
      .mockImplementation(async (_environmentId, method) => {
        if (method === 'status.get') {
          return {
            capabilities: [
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
              ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
              ORCHESTRATION_WORKER_START_CHECK_RUNTIME_CAPABILITY
            ]
          }
        }
        throw new OrchestrationError('worker_start_check_failed', 'bad brief')
      })
    await expect(
      startFederatedWorker({
        params: {
          task: task.id,
          from: 'term_coord',
          on: 'remote',
          worktree: 'id:remote',
          agent: 'codex'
        },
        runtime,
        db,
        runId: run.id,
        task,
        orchestrationMutation: {
          callerFingerprint: 'caller',
          requestId: 'remote_bad',
          method: 'orchestration.workerStart',
          payloadHash: 'payload'
        }
      })
    ).rejects.toMatchObject({ code: 'worker_start_check_failed' })
    expect(db.getDispatchContext(task.id)).toBeUndefined()
    expect(remoteCall.mock.calls.map((call) => call[1])).toEqual([
      'status.get',
      'orchestration.federationWorkerStartCheck'
    ])
    expect(remoteCall.mock.calls[1]?.[3]).toBe(10_000)
  })
})
