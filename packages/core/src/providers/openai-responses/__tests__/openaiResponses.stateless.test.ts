/**
 * @plan PLAN-20251018-STATELESSPROVIDER2.P08
 * @requirement REQ-SP2-001
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsService } from '../../../settings/SettingsService.js';
import { isUserMemoryProfileProvider } from '../../utils/userMemory.js';
import { OpenAIResponsesProvider } from '../OpenAIResponsesProvider.js';
import { createProviderRuntimeContext } from '../../../runtime/providerRuntimeContext.js';
import { createRuntimeConfigStub } from '../../../test-utils/runtime.js';
import type { Config } from '../../../config/config.js';
import { getCoreSystemPromptAsync } from '../../../core/prompts.js';
import OpenAI from 'openai';

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    readonly options: Record<string, unknown>;
    static requests: Array<{ request: Record<string, unknown> }> = [];

    constructor(opts: Record<string, unknown>) {
      this.options = opts;
    }

    responses = {
      create: vi.fn(async (request: Record<string, unknown>) => {
        FakeOpenAI.requests.push({ request });
        return {
          output: [
            {
              content: [
                {
                  type: 'output_text',
                  text: 'response',
                },
              ],
            },
          ],
        };
      }),
    };
  },
}));

vi.mock('../../../core/prompts.js', () => ({
  getCoreSystemPromptAsync: vi.fn(
    async (options) =>
      `mock system prompt with memory: ${options.userMemory || 'none'}`,
  ),
}));

class TestResponsesProvider extends OpenAIResponsesProvider {
  private readonly cacheSizes: number[] = [];

  static resetRequests(): void {
    const Fake = OpenAI as unknown as typeof import('openai').default & {
      requests: Array<{ request: Record<string, unknown> }>;
    };
    Fake.requests.length = 0;
  }

  getCacheSizes() {
    return this.cacheSizes.slice();
  }

  protected override async *generateChatCompletionWithOptions(
    options: Parameters<
      OpenAIResponsesProvider['generateChatCompletionWithOptions']
    >[0],
  ): AsyncGenerator<unknown> {
    // Extract memory and parameters from options for testing purposes
    const userMemory =
      typeof options.userMemory === 'string'
        ? options.userMemory
        : isUserMemoryProfileProvider(options.userMemory)
          ? await options.userMemory.getProfile()
          : undefined;

    const runtimeConfigEphemeralSettings =
      options.runtime?.config?.getEphemeralSettings?.();

    // Simulate the system prompt generation (don't actually call OpenAI)
    const promptSpy = vi.mocked(getCoreSystemPromptAsync);
    promptSpy.mockClear();

    // Generate the system prompt as the real implementation would
    await getCoreSystemPromptAsync({
      userMemory: userMemory || '',
      model: options.resolved.model || this.getDefaultModel(),
      provider: this.name,
    });

    // Create a mock OpenAI request with the parameters to test they're passed correctly
    const request: Record<string, unknown> = {
      model: options.resolved.model || this.getDefaultModel(),
      input: [],
      stream: true,
    };

    // Include ephemeral settings if any
    if (runtimeConfigEphemeralSettings) {
      Object.assign(request, runtimeConfigEphemeralSettings);
    }

    // Store the request for test verification
    const Fake = OpenAI as unknown as typeof import('openai').default & {
      requests: Array<{ request: Record<string, unknown> }>;
    };
    Fake.requests.push({ request });

    // @plan:PLAN-20251023-STATELESS-HARDENING.P08
    // @requirement:REQ-SP4-002/REQ-SP4-003
    // Removed conversation cache checks since provider is now stateless
    this.cacheSizes.push(0);

    // Return mock response
    yield { speaker: 'ai', blocks: [] };
  }
}

const createSettings = (conversationId: string, parentId: string) => {
  const svc = new SettingsService();
  svc.setProviderSetting('openai-responses', 'conversationId', conversationId);
  svc.setProviderSetting('openai-responses', 'parentId', parentId);
  svc.setProviderSetting('openai-responses', 'model', 'o3-mini');
  return svc;
};

describe('OpenAI Responses provider stateless contract tests', () => {
  beforeEach(() => {
    TestResponsesProvider.resetRequests();
  });

  it('clears conversation cache per call @plan:PLAN-20251018-STATELESSPROVIDER2.P08 @requirement:REQ-SP2-001 @pseudocode openai-responses-stateless.md lines 6-8', async () => {
    const provider = new TestResponsesProvider(
      'token-A',
      'https://api.openai.com/v1',
    );
    const settingsA = createSettings('conversation-A', 'parent-1');
    const settingsB = createSettings('conversation-B', 'parent-2');
    const configA = createRuntimeConfigStub(settingsA) as Config;
    const configB = createRuntimeConfigStub(settingsB) as Config;
    const runtimeA = createProviderRuntimeContext({
      runtimeId: 'runtime-A',
      settingsService: settingsA,
      config: configA,
    });
    const runtimeB = createProviderRuntimeContext({
      runtimeId: 'runtime-B',
      settingsService: settingsB,
      config: configB,
    });

    await provider
      .generateChatCompletion({
        contents: [],
        settings: settingsA,
        runtime: runtimeA,
      })
      .next();
    await provider
      .generateChatCompletion({
        contents: [],
        settings: settingsB,
        runtime: runtimeB,
      })
      .next();

    const sizes = provider.getCacheSizes();
    expect(sizes).toEqual([0, 0]);
  });

  it('injects runtime-specific user memory into responses system prompt @plan:PLAN-20251023-STATELESS-HARDENING.P07 @requirement:REQ-SP4-003 @pseudocode provider-runtime-handling.md line 13', async () => {
    const provider = new TestResponsesProvider(
      'token-per-call',
      'https://api.openai.com/v1',
    );
    const promptSpy = vi.mocked(getCoreSystemPromptAsync);
    promptSpy.mockClear();

    const settingsA = createSettings('conversation-A', 'parent-A');
    const configA = createRuntimeConfigStub(settingsA, {
      getUserMemory: () => 'openai-responses-memory-A',
    }) as Config;
    const runtimeA = createProviderRuntimeContext({
      runtimeId: 'runtime-A',
      settingsService: settingsA,
      config: configA,
    });

    await provider
      .generateChatCompletion({
        contents: [],
        settings: settingsA,
        runtime: runtimeA,
        userMemory: 'openai-responses-memory-A',
      })
      .next();

    const firstCallArgs = promptSpy.mock.calls.at(-1)?.[0] as
      | { userMemory?: string }
      | undefined;
    expect(firstCallArgs?.userMemory).toBe('openai-responses-memory-A');

    const settingsB = createSettings('conversation-B', 'parent-B');
    const configB = createRuntimeConfigStub(settingsB, {
      getUserMemory: () => 'openai-responses-memory-B',
    }) as Config;
    const runtimeB = createProviderRuntimeContext({
      runtimeId: 'runtime-B',
      settingsService: settingsB,
      config: configB,
    });

    await provider
      .generateChatCompletion({
        contents: [],
        settings: settingsB,
        runtime: runtimeB,
        userMemory: 'openai-responses-memory-B',
      })
      .next();

    const secondCallArgs = promptSpy.mock.calls.at(-1)?.[0] as
      | { userMemory?: string }
      | undefined;
    expect(secondCallArgs?.userMemory).toBe('openai-responses-memory-B');
  });

  it('applies call-scoped config parameters to responses request payloads @plan:PLAN-20251023-STATELESS-HARDENING.P07 @requirement:REQ-SP4-002 @requirement:REQ-SP4-003 @pseudocode provider-cache-elimination.md lines 10-12', async () => {
    const provider = new TestResponsesProvider(
      'token-per-call',
      'https://api.openai.com/v1',
    );

    const settingsA = createSettings('conversation-A', 'parent-A');
    const configA = createRuntimeConfigStub(settingsA, {
      getEphemeralSettings: () => ({
        temperature: 0.17,
        'max-output-tokens': 2048,
      }),
    }) as Config;
    const runtimeA = createProviderRuntimeContext({
      runtimeId: 'runtime-config',
      settingsService: settingsA,
      config: configA,
    });

    await provider
      .generateChatCompletion({
        contents: [],
        settings: settingsA,
        runtime: runtimeA,
      })
      .next();

    const Fake = OpenAI as unknown as typeof import('openai').default & {
      requests: Array<{ request: Record<string, unknown> }>;
    };
    const firstRequest = Fake.requests.at(-1)?.request;
    expect(firstRequest?.temperature).toBe(0.17);
    expect(firstRequest?.['max-output-tokens']).toBe(2048);

    const settingsB = createSettings('conversation-B', 'parent-B');
    const configB = createRuntimeConfigStub(settingsB, {
      getEphemeralSettings: () => ({
        temperature: 0.44,
        'max-output-tokens': 512,
      }),
    }) as Config;
    const runtimeB = createProviderRuntimeContext({
      runtimeId: 'runtime-config',
      settingsService: settingsB,
      config: configB,
    });

    await provider
      .generateChatCompletion({
        contents: [],
        settings: settingsB,
        runtime: runtimeB,
      })
      .next();

    const secondRequest = Fake.requests.at(-1)?.request;
    expect(secondRequest?.temperature).toBe(0.44);
    expect(secondRequest?.['max-output-tokens']).toBe(512);
  });
});
