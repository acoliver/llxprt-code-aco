/**
 * @license
 * Copyright 2025 Vybestack LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @plan PLAN-20250120-DEBUGLOGGING.P15
 * @requirement REQ-INT-001.1
 */
import { DebugLogger } from '../../debug/index.js';
import { ProviderManager } from '../ProviderManager.js';
import { getActiveProviderRuntimeContext } from '../../runtime/providerRuntimeContext.js';
import { ConversationCache } from './ConversationCache.js';
import { RESPONSES_API_MODELS } from './RESPONSES_API_MODELS.js';

// Create a single logger instance for the module (following singleton pattern)
const logger = new DebugLogger('llxprt:openai:provider');

// Helper types leveraging public APIs

type OpenAIProviderLike = {
  name: string;
  getCurrentModel?: () => string;
  getConversationCache?: () => ConversationCache;
  shouldUseResponses?: (model: string) => boolean;
  // Fallback index signature for accessing other dynamic props safely
  [key: string]: unknown;
};

export interface OpenAIProviderInfo {
  provider: OpenAIProviderLike | null;
  conversationCache: ConversationCache | null;
  isResponsesAPI: boolean;
  currentModel: string | null;
  remoteTokenInfo: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

/**
 * Retrieves OpenAI provider information from the current ProviderManager instance
 * @param providerManager The ProviderManager instance
 * @returns OpenAI provider info if available, null values otherwise
 */
export function getOpenAIProviderInfo(
  providerManager?: ProviderManager | null,
): OpenAIProviderInfo {
  const result: OpenAIProviderInfo = {
    provider: null,
    conversationCache: null,
    isResponsesAPI: false,
    currentModel: null,
    remoteTokenInfo: {},
  };

  try {
    const runtime = getActiveProviderRuntimeContext();
    const settingsService = runtime.settingsService;
    const config = runtime.config;

    const runtimeManager =
      typeof config?.getProviderManager === 'function'
        ? config.getProviderManager()
        : undefined;
    const manager = providerManager ?? runtimeManager ?? null;

    const activeProviderName =
      (manager?.hasActiveProvider?.()
        ? manager.getActiveProviderName()
        : undefined) ??
      (typeof config?.getProvider === 'function'
        ? config.getProvider()
        : undefined);

    if (activeProviderName !== 'openai') {
      return result;
    }

    // Narrow to expected provider type using feature detection for ancillary data
    let openaiProvider: OpenAIProviderLike | null = null;
    if (manager && manager.hasActiveProvider()) {
      const activeProvider = manager.getActiveProvider();
      if (activeProvider?.name === 'openai') {
        openaiProvider = activeProvider as unknown as OpenAIProviderLike;
      }
    }

    result.provider = openaiProvider;

    if (openaiProvider) {
      if (typeof openaiProvider.getConversationCache === 'function') {
        result.conversationCache = openaiProvider.getConversationCache();
      } else if ('conversationCache' in openaiProvider) {
        result.conversationCache =
          (
            openaiProvider as {
              conversationCache?: ConversationCache;
            }
          ).conversationCache ?? null;
      }
    }

    const ephemeralModel = settingsService.get('model') as string | undefined;
    const providerSettings =
      settingsService.getProviderSettings('openai') ??
      ({} as Record<string, unknown>);
    const providerModel = providerSettings.model as string | undefined;
    const configModel =
      typeof config?.getModel === 'function' ? config.getModel() : undefined;

    const normalizedModel =
      (typeof ephemeralModel === 'string' && ephemeralModel.trim() !== ''
        ? ephemeralModel.trim()
        : undefined) ??
      providerModel ??
      configModel;
    result.currentModel = normalizedModel ?? null;

    const configuredMode =
      (providerSettings.apiMode as string | undefined) ??
      (providerSettings.responsesMode as string | undefined) ??
      (settingsService.get('responses-mode') as string | undefined);

    if (configuredMode) {
      result.isResponsesAPI = configuredMode.toLowerCase() === 'responses';
    } else if (result.currentModel) {
      if (openaiProvider?.shouldUseResponses) {
        result.isResponsesAPI = openaiProvider.shouldUseResponses(
          result.currentModel,
        );
      } else {
        result.isResponsesAPI = (
          RESPONSES_API_MODELS as readonly string[]
        ).includes(result.currentModel);
      }
    }

    // Note: Remote token info would need to be tracked separately during API calls
    // This is a placeholder for where that information would be stored
  } catch (error) {
    logger.debug(() => `Error accessing OpenAI provider info: ${error}`);
  }

  return result;
}

/**
 * Example usage:
 *
 * const openAIInfo = getOpenAIProviderInfo(providerManager);
 * if (openAIInfo.provider && openAIInfo.conversationCache) {
 *   // Access conversation cache
 *   const cachedMessages = openAIInfo.conversationCache.get(conversationId, parentId);
 *
 *   // Check if using Responses API
 *   if (openAIInfo.isResponsesAPI) {
 *     console.log('Using OpenAI Responses API');
 *   }
 * }
 */
