/**
 * @license
 * Copyright 2025 Vybestack LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createProviderRuntimeContext,
  setActiveProviderRuntimeContext,
  SettingsService,
  type ProviderRuntimeContext,
  type ProviderManager,
} from '@vybestack/llxprt-code-core';
import { createProviderManager } from '../providers/providerManagerInstance.js';
import { registerCliProviderInfrastructure } from '../runtime/runtimeSettings.js';
import type { OAuthManager } from '../auth/oauth-manager.js';

const DEFAULT_RUNTIME_ID = 'cli.runtime.bootstrap';

export interface BootstrapProfileArgs {
  profileName: string | null;
  providerOverride: string | null;
  modelOverride: string | null;
}

export interface RuntimeBootstrapMetadata {
  settingsService?: SettingsService;
  config?: ProviderRuntimeContext['config'];
  runtimeId?: string;
  metadata?: Record<string, unknown>;
}

export interface ParsedBootstrapArgs {
  bootstrapArgs: BootstrapProfileArgs;
  runtimeMetadata: RuntimeBootstrapMetadata;
}

export interface BootstrapRuntimeState {
  runtime: ProviderRuntimeContext;
  providerManager: ProviderManager;
  oauthManager?: OAuthManager;
}

export interface ProfileApplicationResult {
  providerName: string;
  modelName: string;
  baseUrl?: string;
  warnings: string[];
}

export interface BootstrapResult {
  runtime: ProviderRuntimeContext;
  providerManager: ProviderManager;
  oauthManager?: OAuthManager;
  bootstrapArgs: BootstrapProfileArgs;
  profile: ProfileApplicationResult;
}

function normaliseArgValue(value: string | undefined | null): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * @plan PLAN-20251020-STATELESSPROVIDER3.P06
 * @requirement REQ-SP3-001
 * @pseudocode bootstrap-order.md lines 1-9
 */
export function parseBootstrapArgs(): ParsedBootstrapArgs {
  const argv = process.argv.slice(2);
  const bootstrapArgs: BootstrapProfileArgs = {
    profileName: null,
    providerOverride: null,
    modelOverride: null,
  };

  const runtimeMetadata: RuntimeBootstrapMetadata = {
    runtimeId: process.env.LLXPRT_RUNTIME_ID ?? DEFAULT_RUNTIME_ID,
    metadata: {
      source: 'cli.bootstrap',
      argv: argv.slice(),
      timestamp: Date.now(),
    },
  };

  const consumeValue = (
    tokens: string[],
    currentIndex: number,
    inlineValue: string | undefined,
  ): { value: string | null; nextIndex: number } => {
    if (inlineValue !== undefined) {
      return { value: normaliseArgValue(inlineValue), nextIndex: currentIndex };
    }
    const nextToken = tokens[currentIndex + 1];
    if (nextToken && !nextToken.startsWith('-')) {
      return {
        value: normaliseArgValue(nextToken),
        nextIndex: currentIndex + 1,
      };
    }
    return { value: null, nextIndex: currentIndex };
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('-')) {
      continue;
    }

    const [flag, inline] = token.split('=', 2);

    switch (flag) {
      case '--profile-load': {
        const { value, nextIndex } = consumeValue(argv, index, inline);
        bootstrapArgs.profileName = value;
        index = nextIndex;
        break;
      }
      case '--provider': {
        const { value, nextIndex } = consumeValue(argv, index, inline);
        bootstrapArgs.providerOverride = value;
        index = nextIndex;
        break;
      }
      case '--model':
      case '-m': {
        const { value, nextIndex } = consumeValue(argv, index, inline);
        bootstrapArgs.modelOverride = value;
        index = nextIndex;
        break;
      }
      default:
        break;
    }
  }

  return { bootstrapArgs, runtimeMetadata };
}

/**
 * @plan PLAN-20251020-STATELESSPROVIDER3.P06
 * @requirement REQ-SP3-001
 * @pseudocode bootstrap-order.md lines 1-9
 */
export async function prepareRuntimeForProfile(
  parsed: ParsedBootstrapArgs,
): Promise<BootstrapRuntimeState> {
  const runtimeInit = parsed.runtimeMetadata;
  const providedService = runtimeInit.settingsService;
  const settingsService =
    providedService instanceof SettingsService
      ? providedService
      : new SettingsService();

  const runtime = createProviderRuntimeContext({
    settingsService,
    config: runtimeInit.config,
    runtimeId: runtimeInit.runtimeId ?? DEFAULT_RUNTIME_ID,
    metadata: {
      ...(runtimeInit.metadata ?? {}),
      stage: 'prepareRuntimeForProfile',
    },
  });

  setActiveProviderRuntimeContext(runtime);

  const { manager: providerManager, oauthManager } = createProviderManager(
    {
      settingsService: runtime.settingsService,
      config: runtime.config,
      runtimeId: runtime.runtimeId,
      metadata: runtime.metadata,
    },
    {
      config: runtime.config,
    },
  );

  registerCliProviderInfrastructure(providerManager, oauthManager);

  return {
    runtime,
    providerManager,
    oauthManager,
  };
}

/**
 * @plan PLAN-20251020-STATELESSPROVIDER3.P06
 * @requirement REQ-SP3-001
 * @pseudocode bootstrap-order.md lines 1-9
 */
export function createBootstrapResult(input: {
  runtime: BootstrapRuntimeState['runtime'];
  providerManager: BootstrapRuntimeState['providerManager'];
  oauthManager?: BootstrapRuntimeState['oauthManager'];
  bootstrapArgs: BootstrapProfileArgs;
  profileApplication: ProfileApplicationResult;
}): BootstrapResult {
  const runtimeMetadata = {
    ...(input.runtime.metadata ?? {}),
    stage: 'bootstrap-complete',
  };

  const runtime: ProviderRuntimeContext = {
    ...input.runtime,
    metadata: runtimeMetadata,
  };

  return {
    runtime,
    providerManager: input.providerManager,
    oauthManager: input.oauthManager,
    bootstrapArgs: input.bootstrapArgs,
    profile: input.profileApplication,
  };
}
