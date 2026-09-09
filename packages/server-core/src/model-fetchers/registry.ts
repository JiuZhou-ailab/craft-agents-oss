// input: Provider connections, credentials, and initialized host runtime
// output: Model fetchers with provider-specific refresh intervals
// pos: Server model discovery registry delegating to the shared backend

import type { ModelFetcher, ModelFetcherMap } from '@craft-agent/shared/config'
import { fetchBackendModels } from '@craft-agent/shared/agent/backend'
import { getHostRuntime, handlerLog } from './runtime'

const fetchModels: ModelFetcher['fetchModels'] = (connection, credentials) =>
  fetchBackendModels({ connection, credentials, hostRuntime: getHostRuntime() })

export const MODEL_FETCHERS: ModelFetcherMap = {
  anthropic: {
    refreshIntervalMs: 60 * 60 * 1000,
    async fetchModels(connection, credentials) {
      const result = await fetchModels(connection, credentials)
      handlerLog.info(`Fetched ${result.models.length} Anthropic models: ${result.models.map(m => m.id).join(', ')}`)
      return result
    },
  },
  pi: { refreshIntervalMs: 0, fetchModels },
}
