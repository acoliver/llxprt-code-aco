/**
 * @license
 * Copyright 2025 Vybestack LLC
 * SPDX-License-Identifier: Apache-2.0
 * @plan PLAN-20250909-TOKTRACK.P08
 */

import { IProvider } from './IProvider.js';
import { IModel } from './IModel.js';
import { IProviderManager } from './IProviderManager.js';
import { Config } from '../config/config.js';
import { LoggingProviderWrapper } from './LoggingProviderWrapper.js';
import {
  logProviderSwitch,
  logProviderCapability,
} from '../telemetry/loggers.js';
import {
  ProviderSwitchEvent,
  ProviderCapabilityEvent,
} from '../telemetry/types.js';
import type {
  ProviderCapabilities,
  ProviderContext,
  ProviderComparison,
} from './types.js';
import type { SettingsService } from '../settings/SettingsService.js';
import {
  getActiveProviderRuntimeContext,
  type ProviderRuntimeContext,
} from '../runtime/providerRuntimeContext.js';
import { MissingProviderRuntimeError } from './errors.js';

const PROVIDER_CAPABILITY_HINTS: Record<
  string,
  Partial<ProviderCapabilities>
> = {
  gemini: {
    hasModelSelection: true,
    hasApiKeyConfig: true,
    hasBaseUrlConfig: false,
  },
  openai: {
    hasModelSelection: true,
    hasApiKeyConfig: true,
    hasBaseUrlConfig: true,
  },
  'openai-responses': {
    hasModelSelection: false,
    hasApiKeyConfig: true,
    hasBaseUrlConfig: true,
  },
  anthropic: {
    hasModelSelection: true,
    hasApiKeyConfig: true,
    hasBaseUrlConfig: true,
  },
};

interface ProviderManagerInit {
  runtime?: ProviderRuntimeContext;
  config?: Config;
  settingsService?: SettingsService;
}

export class ProviderManager implements IProviderManager {
  private providers: Map<string, IProvider>;
  private serverToolsProvider: IProvider | null;
  private config?: Config;
  /**
   * @plan PLAN-20250218-STATELESSPROVIDER.P05
   * @requirement REQ-SP-001
   * @pseudocode provider-invocation.md lines 8-15
   */
  private settingsService: SettingsService;
  private runtime?: ProviderRuntimeContext;
  private providerCapabilities: Map<string, ProviderCapabilities> = new Map();
  private sessionTokenUsage: {
    input: number;
    output: number;
    cache: number;
    tool: number;
    thought: number;
    total: number;
  } = {
    input: 0,
    output: 0,
    cache: 0,
    tool: 0,
    thought: 0,
    total: 0,
  };

  constructor(init?: ProviderManagerInit | ProviderRuntimeContext) {
    const resolved = this.resolveInit(init);
    this.providers = new Map<string, IProvider>();
    this.serverToolsProvider = null;
    this.settingsService = resolved.settingsService;
    this.config = resolved.config ?? this.config;
    this.runtime = resolved.runtime;
  }

  /**
   * @plan PLAN-20250218-STATELESSPROVIDER.P05
   * @requirement REQ-SP-001
   * @pseudocode provider-invocation.md lines 8-15
   * @plan:PLAN-20251018-STATELESSPROVIDER2.P03
   * @requirement:REQ-SP2-002
   * @pseudocode multi-runtime-baseline.md lines 3-4
   */
  private resolveInit(init?: ProviderManagerInit | ProviderRuntimeContext): {
    settingsService: SettingsService;
    config?: Config;
    runtime?: ProviderRuntimeContext;
  } {
    let fallback: ProviderRuntimeContext | null = null;
    const ensureFallback = (): ProviderRuntimeContext => {
      if (!fallback) {
        fallback = getActiveProviderRuntimeContext();
      }
      return fallback;
    };

    if (!init) {
      const resolved = ensureFallback();
      return {
        settingsService: resolved.settingsService,
        config: resolved.config,
        runtime: resolved,
      };
    }

    if (
      typeof init === 'object' &&
      init !== null &&
      'settingsService' in init &&
      ('runtimeId' in init || 'metadata' in init)
    ) {
      const context = init as ProviderRuntimeContext;
      return {
        settingsService: context.settingsService,
        config: context.config,
        runtime: context,
      };
    }

    const initObj = init as ProviderManagerInit;
    const runtime = initObj.runtime;
    let settingsService =
      initObj.settingsService ?? runtime?.settingsService ?? null;
    let config: Config | undefined =
      initObj.config ?? runtime?.config ?? undefined;

    if (!settingsService || !config) {
      const resolved = ensureFallback();
      settingsService = settingsService ?? resolved.settingsService;
      config = config ?? resolved.config;
      return {
        settingsService,
        config,
        runtime: runtime ?? resolved,
      };
    }

    return {
      settingsService,
      config,
      runtime,
    };
  }

  setConfig(config: Config): void {
    const oldLoggingEnabled =
      this.config?.getConversationLoggingEnabled() ?? false;
    const newLoggingEnabled = config.getConversationLoggingEnabled();

    this.config = config;
    this.runtime = this.runtime
      ? { ...this.runtime, config }
      : { settingsService: this.settingsService, config };

    // If logging state changed, update provider wrapping
    if (oldLoggingEnabled !== newLoggingEnabled) {
      this.updateProviderWrapping();
    }
  }

  /**
   * @plan PLAN-20251018-STATELESSPROVIDER2.P06
   * @requirement REQ-SP2-001
   * @pseudocode base-provider-call-contract.md lines 3-5
   */
  private updateProviderWrapping(): void {
    // Re-wrap all providers (ALWAYS wrap for token tracking)
    const providers = new Map(this.providers);

    for (const [name, provider] of providers) {
      // Unwrap if it's already wrapped
      let baseProvider = provider;
      if ('wrappedProvider' in provider && provider.wrappedProvider) {
        baseProvider = provider.wrappedProvider as IProvider;
      }

      this.syncProviderRuntime(baseProvider);

      // ALWAYS wrap with LoggingProviderWrapper for token tracking
      let finalProvider = baseProvider;
      if (this.config) {
        finalProvider = new LoggingProviderWrapper(baseProvider, this.config);
      }

      this.syncProviderRuntime(finalProvider);
      this.providers.set(name, finalProvider);

      // Update server tools provider reference if needed
      if (this.serverToolsProvider && this.serverToolsProvider.name === name) {
        this.serverToolsProvider = finalProvider;
      }
    }
  }

  /**
   * @plan PLAN-20250218-STATELESSPROVIDER.P05
   * @requirement REQ-SP-001
   * @pseudocode provider-invocation.md lines 8-15
   * @plan:PLAN-20251023-STATELESS-HARDENING.P05
   * @requirement:REQ-SP4-001
   * @pseudocode provider-runtime-handling.md lines 10-15
   */
  private syncProviderRuntime(provider: IProvider): void {
    const runtimeAware = provider as IProvider & {
      setRuntimeSettingsService?: (settingsService: SettingsService) => void;
      setConfig?: (config: Config) => void;
      setRuntimeContextResolver?: (
        resolver: () => ProviderRuntimeContext,
      ) => void;
    };
    runtimeAware.setRuntimeSettingsService?.(this.settingsService);
    if (this.config && runtimeAware.setConfig) {
      runtimeAware.setConfig(this.config);
    }
    if (
      runtimeAware.setRuntimeContextResolver &&
      typeof runtimeAware.setRuntimeContextResolver === 'function'
    ) {
      runtimeAware.setRuntimeContextResolver(() =>
        this.snapshotRuntimeContext('ProviderManager.syncProviderRuntime'),
      );
    }
  }

  /**
   * @plan:PLAN-20251023-STATELESS-HARDENING.P05
   * @requirement:REQ-SP4-001
   * @pseudocode provider-runtime-handling.md lines 10-15
   */
  private snapshotRuntimeContext(source: string): ProviderRuntimeContext {
    const baseRuntime: ProviderRuntimeContext = this.runtime ?? {
      settingsService: this.settingsService,
      config: this.config,
      runtimeId: 'provider-manager.default-runtime',
      metadata: { source: 'ProviderManager', requirement: 'REQ-SP4-001' },
    };

    if (!this.runtime) {
      this.runtime = baseRuntime;
    } else if (!this.runtime.config && baseRuntime.config) {
      this.runtime = { ...this.runtime, config: baseRuntime.config };
    }

    const settingsService = baseRuntime.settingsService;
    if (!settingsService) {
      throw new MissingProviderRuntimeError({
        providerKey: 'ProviderManager',
        missingFields: ['settings'],
        stage: source,
        metadata: {
          requirement: 'REQ-SP4-001',
          hint: 'ProviderManager requires a SettingsService to construct runtime contexts.',
        },
      });
    }

    const config = baseRuntime.config ?? this.config;
    if (!config) {
      throw new MissingProviderRuntimeError({
        providerKey: 'ProviderManager',
        missingFields: ['config'],
        stage: source,
        metadata: {
          requirement: 'REQ-SP4-001',
          hint: 'Call ProviderManager.setConfig before invoking providers.',
        },
      });
    }

    const baseMetadata = baseRuntime.metadata ?? {};
    const callMetadata: Record<string, unknown> = {
      ...baseMetadata,
      source,
      requirement: 'REQ-SP4-001',
      generatedAt: new Date().toISOString(),
    };

    const baseId = baseRuntime.runtimeId;
    const callRuntimeId =
      typeof baseId === 'string' && baseId.trim() !== ''
        ? `${baseId}:${Math.random().toString(36).slice(2, 10)}`
        : `provider-manager:${source}:${Date.now().toString(36)}`;

    return {
      settingsService,
      config,
      runtimeId: callRuntimeId,
      metadata: callMetadata,
    };
  }

  /**
   * @plan PLAN-20251018-STATELESSPROVIDER2.P06
   * @requirement REQ-SP2-001
   * @pseudocode base-provider-call-contract.md lines 3-5
   */
  registerProvider(provider: IProvider): void {
    this.syncProviderRuntime(provider);
    // ALWAYS wrap provider to enable token tracking
    // (LoggingProviderWrapper handles both token tracking AND conversation logging)
    let finalProvider = provider;
    if (this.config) {
      finalProvider = new LoggingProviderWrapper(provider, this.config);
    }

    this.syncProviderRuntime(finalProvider);

    this.providers.set(provider.name, finalProvider);

    // Capture provider capabilities
    const capabilities = this.captureProviderCapabilities(provider);
    this.providerCapabilities.set(provider.name, capabilities);

    // Log provider capability information if logging enabled
    if (this.config?.getConversationLoggingEnabled()) {
      const context = this.createProviderContext(provider, capabilities);
      logProviderCapability(
        this.config,
        new ProviderCapabilityEvent(provider.name, capabilities, context),
      );
    }

    // If this is the default provider and no provider is active, set it as active
    const currentActiveProvider = this.settingsService.get(
      'activeProvider',
    ) as string;
    if (provider.isDefault && !currentActiveProvider) {
      this.settingsService.set('activeProvider', provider.name);
    }

    // If registering Gemini and we don't have a serverToolsProvider, use it
    if (provider.name === 'gemini' && !this.serverToolsProvider) {
      this.serverToolsProvider = provider;
    }

    // If Gemini is the active provider, it should also be the serverToolsProvider
    if (provider.name === 'gemini' && currentActiveProvider === 'gemini') {
      this.serverToolsProvider = provider;
    }
  }

  /**
   * @plan PLAN-20251018-STATELESSPROVIDER2.P06
   * @requirement REQ-SP2-001
   * @pseudocode base-provider-call-contract.md lines 3-5
   */
  setActiveProvider(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error('Provider not found');
    }

    // Store reference to the current active provider before switching
    const previousProviderName =
      (this.settingsService.get('activeProvider') as string) || '';

    // Only clear state from the provider we're switching FROM
    // BUT never clear the serverToolsProvider's state
    if (previousProviderName && previousProviderName !== name) {
      const previousProvider = this.providers.get(previousProviderName);
      if (
        previousProvider &&
        previousProvider !== this.serverToolsProvider &&
        'clearState' in previousProvider
      ) {
        const candidate = previousProvider as { clearState?: () => void };
        candidate.clearState?.();
      }
    }

    // Log provider switch if conversation logging enabled
    if (
      this.config?.getConversationLoggingEnabled() &&
      previousProviderName &&
      previousProviderName !== name
    ) {
      logProviderSwitch(
        this.config,
        new ProviderSwitchEvent(
          previousProviderName,
          name,
          this.generateConversationId(),
          this.isContextPreserved(previousProviderName, name),
        ),
      );
    }

    // Update SettingsService as the single source of truth
    this.settingsService.set('activeProvider', name);

    // If switching to Gemini, use it as both active and serverTools provider
    // BUT only if we don't already have a Gemini serverToolsProvider with auth state
    if (name === 'gemini') {
      // Only replace serverToolsProvider if it's not already Gemini or if it's null
      if (
        !this.serverToolsProvider ||
        this.serverToolsProvider.name !== 'gemini'
      ) {
        this.serverToolsProvider = this.providers.get(name) || null;
      }
    }
    // If switching away from Gemini but serverToolsProvider is not set,
    // configure a Gemini provider for serverTools if available
    else if (!this.serverToolsProvider && this.providers.has('gemini')) {
      this.serverToolsProvider = this.providers.get('gemini') || null;
    }
  }

  clearActiveProvider(): void {
    this.settingsService.set('activeProvider', '');
  }

  getActiveProvider(): IProvider {
    const activeProviderName =
      (this.settingsService.get('activeProvider') as string) || '';

    let resolvedName = activeProviderName;

    if (!resolvedName) {
      const preferredFromConfig = this.config?.getProvider?.();
      if (preferredFromConfig && this.providers.has(preferredFromConfig)) {
        resolvedName = preferredFromConfig;
      } else if (this.providers.has('openai')) {
        resolvedName = 'openai';
      } else {
        const firstProvider = this.providers.keys().next();
        resolvedName = firstProvider.done ? '' : firstProvider.value;
      }

      if (resolvedName) {
        try {
          this.setActiveProvider(resolvedName);
        } catch (error) {
          throw new Error(
            `Unable to set default provider '${resolvedName}': ${String(error)}`,
          );
        }
      }
    }

    if (!resolvedName) {
      throw new Error('No active provider set');
    }

    const provider = this.providers.get(resolvedName);
    if (!provider) {
      throw new Error('Active provider not found');
    }
    return provider;
  }

  async getAvailableModels(providerName?: string): Promise<IModel[]> {
    let provider: IProvider | undefined;

    if (providerName) {
      provider = this.providers.get(providerName);
      if (!provider) {
        throw new Error(`Provider '${providerName}' not found`);
      }
    } else {
      provider = this.getActiveProvider();
    }

    return provider.getModels();
  }

  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Get a provider by name (for OAuth manager)
   */
  getProviderByName(name: string): IProvider | undefined {
    return this.providers.get(name);
  }

  getActiveProviderName(): string {
    return (this.settingsService.get('activeProvider') as string) || '';
  }

  hasActiveProvider(): boolean {
    const activeProviderName =
      (this.settingsService.get('activeProvider') as string) || '';
    return activeProviderName !== '' && this.providers.has(activeProviderName);
  }

  getServerToolsProvider(): IProvider | null {
    // If we have a configured serverToolsProvider, return it
    if (this.serverToolsProvider) {
      return this.serverToolsProvider;
    }

    // Otherwise, try to get Gemini if available
    const geminiProvider = this.providers.get('gemini');
    if (geminiProvider) {
      this.serverToolsProvider = geminiProvider;
      return geminiProvider;
    }

    return null;
  }

  setServerToolsProvider(provider: IProvider | null): void {
    this.serverToolsProvider = provider;
  }

  private generateConversationId(): string {
    // Generate unique conversation ID for session
    return `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private isContextPreserved(
    fromProvider: string,
    toProvider: string,
  ): boolean {
    // Analyze whether context can be preserved between providers
    const fromCapabilities = this.providerCapabilities.get(fromProvider);
    const toCapabilities = this.providerCapabilities.get(toProvider);

    if (!fromCapabilities || !toCapabilities) {
      return false; // Can't analyze without capabilities
    }

    // Context is better preserved between providers with similar capabilities
    const capabilityScore = this.calculateCapabilityCompatibility(
      fromCapabilities,
      toCapabilities,
    );

    // Context is considered preserved if compatibility is high
    return capabilityScore > 0.7;
  }

  private getStoredModelName(provider: IProvider): string {
    const providerSettings = this.settingsService.getProviderSettings(
      provider.name,
    );
    const storedModel = providerSettings.model as string | undefined;
    if (storedModel && typeof storedModel === 'string' && storedModel.trim()) {
      return storedModel;
    }

    if (
      this.config &&
      typeof this.config.getProvider === 'function' &&
      this.config.getProvider() === provider.name
    ) {
      const configModel = this.config.getModel();
      if (configModel) {
        return configModel;
      }
    }

    return provider.getDefaultModel?.() ?? '';
  }

  private captureProviderCapabilities(
    provider: IProvider,
  ): ProviderCapabilities {
    const hints = PROVIDER_CAPABILITY_HINTS[provider.name] ?? {};

    return {
      supportsStreaming: true, // All current providers support streaming
      supportsTools: provider.getServerTools().length > 0,
      supportsVision: this.detectVisionSupport(provider),
      maxTokens: this.getProviderMaxTokens(provider),
      supportedFormats: this.getSupportedToolFormats(provider),
      hasModelSelection: hints.hasModelSelection ?? true,
      hasApiKeyConfig: hints.hasApiKeyConfig ?? true,
      hasBaseUrlConfig: hints.hasBaseUrlConfig ?? true,
      supportsPaidMode: typeof provider.isPaidMode === 'function',
    };
  }

  private detectVisionSupport(provider: IProvider): boolean {
    // Provider-specific vision detection logic
    const model = this.getStoredModelName(provider).toLowerCase();
    switch (provider.name) {
      case 'gemini': {
        return true;
      }
      case 'openai': {
        return model.includes('vision') || model.includes('gpt-4');
      }
      case 'anthropic': {
        return model.includes('claude-3');
      }
      default:
        return false;
    }
  }

  private getProviderMaxTokens(provider: IProvider): number {
    const model = this.getStoredModelName(provider).toLowerCase();

    switch (provider.name) {
      case 'gemini':
        if (model.includes('pro')) return 32768;
        if (model.includes('flash')) return 8192;
        return 8192;
      case 'openai':
        if (model.includes('gpt-4')) return 8192;
        if (model.includes('gpt-3.5')) return 4096;
        return 4096;
      case 'anthropic':
        if (model.includes('claude-3')) return 200000;
        return 100000;
      default:
        return 4096;
    }
  }

  private getSupportedToolFormats(provider: IProvider): string[] {
    switch (provider.name) {
      case 'gemini':
        return ['function_calling', 'gemini_tools'];
      case 'openai':
        return ['function_calling', 'json_schema', 'hermes'];
      case 'anthropic':
        return ['xml_tools', 'anthropic_tools'];
      default:
        return [];
    }
  }

  private createProviderContext(
    provider: IProvider,
    capabilities: ProviderCapabilities,
  ): ProviderContext {
    const providerSettings = this.settingsService.getProviderSettings(
      provider.name,
    );
    const toolFormatSetting =
      (providerSettings.toolFormat as string | undefined) ?? 'auto';
    return {
      providerName: provider.name,
      currentModel: this.getStoredModelName(provider) || 'unknown',
      toolFormat: toolFormatSetting,
      isPaidMode: provider.isPaidMode?.() || false,
      capabilities,
      sessionStartTime: Date.now(),
    };
  }

  private calculateCapabilityCompatibility(
    from: ProviderCapabilities,
    to: ProviderCapabilities,
  ): number {
    let score = 0;
    let totalChecks = 0;

    // Check tool support compatibility
    totalChecks++;
    if (from.supportsTools === to.supportsTools) score++;

    // Check vision support compatibility
    totalChecks++;
    if (from.supportsVision === to.supportsVision) score++;

    // Check streaming compatibility (all providers support streaming currently)
    totalChecks++;
    if (from.supportsStreaming === to.supportsStreaming) score++;

    // Check tool format compatibility
    totalChecks++;
    const hasCommonFormats = from.supportedFormats.some((format) =>
      to.supportedFormats.includes(format),
    );
    if (hasCommonFormats) score++;

    return score / totalChecks;
  }

  /**
   * Accumulate token usage for the current session
   */
  accumulateSessionTokens(
    providerName: string,
    usage: {
      input: number;
      output: number;
      cache: number;
      tool: number;
      thought: number;
    },
  ): void {
    // Only accumulate non-negative values
    this.sessionTokenUsage.input += Math.max(0, usage.input || 0);
    this.sessionTokenUsage.output += Math.max(0, usage.output || 0);
    this.sessionTokenUsage.cache += Math.max(0, usage.cache || 0);
    this.sessionTokenUsage.tool += Math.max(0, usage.tool || 0);
    this.sessionTokenUsage.thought += Math.max(0, usage.thought || 0);
    this.sessionTokenUsage.total +=
      Math.max(0, usage.input || 0) +
      Math.max(0, usage.output || 0) +
      Math.max(0, usage.cache || 0) +
      Math.max(0, usage.tool || 0) +
      Math.max(0, usage.thought || 0);
  }

  /**
   * Reset session token usage counters
   */
  resetSessionTokenUsage(): void {
    this.sessionTokenUsage = {
      input: 0,
      output: 0,
      cache: 0,
      tool: 0,
      thought: 0,
      total: 0,
    };
  }

  /**
   * Get current session token usage
   */
  getSessionTokenUsage(): {
    input: number;
    output: number;
    cache: number;
    tool: number;
    thought: number;
    total: number;
  } {
    // Validate and replace any NaN or undefined values with 0
    return {
      input: this.sessionTokenUsage.input || 0,
      output: this.sessionTokenUsage.output || 0,
      cache: this.sessionTokenUsage.cache || 0,
      tool: this.sessionTokenUsage.tool || 0,
      thought: this.sessionTokenUsage.thought || 0,
      total: this.sessionTokenUsage.total || 0,
    };
  }

  /**
   * Get performance metrics for the active provider
   * @plan PLAN-20250909-TOKTRACK
   */
  getProviderMetrics(providerName?: string) {
    const name = providerName || this.getActiveProvider()?.name;
    if (!name) return null;

    const provider = this.providers.get(name);
    if (!provider) return null;

    // Check if provider has getPerformanceMetrics method (LoggingProviderWrapper)
    if (
      'getPerformanceMetrics' in provider &&
      typeof provider.getPerformanceMetrics === 'function'
    ) {
      return provider.getPerformanceMetrics();
    }

    // Return default metrics if provider doesn't support performance tracking
    return {
      tokensPerMinute: 0,
      throttleWaitTimeMs: 0,
      totalTokens: 0,
      totalRequests: 0,
    };
  }

  resetConversationContext(): void {
    // Conversation ID is now managed by the logging system
  }

  getProviderCapabilities(
    providerName?: string,
  ): ProviderCapabilities | undefined {
    const name =
      providerName ||
      (this.settingsService.get('activeProvider') as string) ||
      '';
    return this.providerCapabilities.get(name);
  }

  compareProviders(provider1: string, provider2: string): ProviderComparison {
    const cap1 = this.providerCapabilities.get(provider1);
    const cap2 = this.providerCapabilities.get(provider2);

    if (!cap1 || !cap2) {
      throw new Error('Cannot compare providers: capabilities not available');
    }

    return {
      provider1,
      provider2,
      capabilities: {
        [provider1]: cap1,
        [provider2]: cap2,
      },
      compatibility: this.calculateCapabilityCompatibility(cap1, cap2),
      recommendation: this.generateProviderRecommendation(
        provider1,
        provider2,
        cap1,
        cap2,
      ),
    };
  }

  private generateProviderRecommendation(
    provider1: string,
    provider2: string,
    cap1: ProviderCapabilities,
    cap2: ProviderCapabilities,
  ): string {
    if (cap1.maxTokens > cap2.maxTokens) {
      return `${provider1} supports longer contexts (${cap1.maxTokens} vs ${cap2.maxTokens} tokens)`;
    }

    if (cap1.supportsVision && !cap2.supportsVision) {
      return `${provider1} supports vision capabilities`;
    }

    if (cap1.supportedFormats.length > cap2.supportedFormats.length) {
      return `${provider1} supports more tool formats`;
    }

    return 'Providers have similar capabilities';
  }
}
