/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeToolCall } from './nonInteractiveToolExecutor.js';
import {
  ToolRegistry,
  ToolCallRequestInfo,
  ToolResult,
  Config,
  ToolErrorType,
  ApprovalMode,
} from '../index.js';
import { Part } from '@google/genai';
import { MockTool } from '../test-utils/tools.js';

describe('executeToolCall', () => {
  let mockToolRegistry: ToolRegistry;
  let mockTool: MockTool;
  let abortController: AbortController;
  let mockConfig: Config;

  beforeEach(() => {
    mockTool = new MockTool('testTool');

    mockToolRegistry = {
      getTool: vi.fn(),
      getAllToolNames: vi.fn().mockReturnValue(['testTool', 'anotherTool']),
      getAllTools: vi.fn().mockReturnValue([]),
    } as unknown as ToolRegistry;

    mockConfig = {
      getToolRegistry: () => mockToolRegistry,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getAllowedTools: () => [],
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'oauth-personal',
      }),
      getEphemeralSetting: vi.fn(),
      getEphemeralSettings: vi.fn().mockReturnValue({}),
      getExcludeTools: () => [],
    } as unknown as Config;

    abortController = new AbortController();
  });

  it('should execute a tool successfully', async () => {
    const request: ToolCallRequestInfo = {
      callId: 'call1',
      name: 'testTool',
      args: { param1: 'value1' },
      isClientInitiated: false,
      prompt_id: 'prompt-id-1',
    };
    const toolResult: ToolResult = {
      llmContent: 'Tool executed successfully',
      returnDisplay: 'Success!',
    };
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);
    mockTool.executeFn.mockReturnValue(toolResult);

    const response = await executeToolCall(
      mockConfig,
      request,
      abortController.signal,
    );

    expect(mockToolRegistry.getTool).toHaveBeenCalledWith('testTool');
    // The executeFn is called via the MockToolInvocation, not directly
    expect(response).toStrictEqual({
      callId: 'call1',
      agentId: 'primary',
      error: undefined,
      errorType: undefined,
      resultDisplay: 'Success!',
      responseParts: [
        {
          functionCall: {
            name: 'testTool',
            id: 'call1',
            args: { param1: 'value1' },
          },
        },
        {
          functionResponse: {
            name: 'testTool',
            id: 'call1',
            response: { output: 'Tool executed successfully' },
          },
        },
      ],
    });
  });

  it('should return an error if tool is not found', async () => {
    const request: ToolCallRequestInfo = {
      callId: 'call2',
      name: 'nonexistentTool',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt-id-2',
    };
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(undefined);
    vi.mocked(mockToolRegistry.getAllToolNames).mockReturnValue([
      'testTool',
      'anotherTool',
    ]);

    const response = await executeToolCall(
      mockConfig,
      request,
      abortController.signal,
    );

    const expectedErrorMessage =
      'Tool "nonexistentTool" not found in registry.';
    expect(response).toStrictEqual({
      callId: 'call2',
      agentId: 'primary',
      error: new Error(expectedErrorMessage),
      errorType: ToolErrorType.TOOL_NOT_REGISTERED,
      resultDisplay: expectedErrorMessage,
      responseParts: [
        {
          functionCall: {
            name: 'nonexistentTool',
            id: 'call2',
            args: {},
          },
        },
        {
          functionResponse: {
            name: 'nonexistentTool',
            id: 'call2',
            response: {
              error: expectedErrorMessage,
            },
          },
        },
      ],
    });
  });

  it('should return an error if tool validation fails', async () => {
    const request: ToolCallRequestInfo = {
      callId: 'call3',
      name: 'testTool',
      args: { param1: 'invalid' },
      isClientInitiated: false,
      prompt_id: 'prompt-id-3',
    };
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);
    vi.spyOn(mockTool, 'build').mockImplementation(() => {
      throw new Error('Invalid parameters');
    });

    const response = await executeToolCall(
      mockConfig,
      request,
      abortController.signal,
    );

    expect(response).toStrictEqual({
      callId: 'call3',
      agentId: 'primary',
      error: new Error('Invalid parameters'),
      errorType: ToolErrorType.UNHANDLED_EXCEPTION,
      responseParts: [
        {
          functionCall: {
            id: 'call3',
            name: 'testTool',
            args: {
              param1: 'invalid',
            },
          },
        },
        {
          functionResponse: {
            id: 'call3',
            name: 'testTool',
            response: {
              error: 'Invalid parameters',
            },
          },
        },
      ],
      resultDisplay: 'Invalid parameters',
    });
  });

  it('should return an error if tool execution fails', async () => {
    const request: ToolCallRequestInfo = {
      callId: 'call4',
      name: 'testTool',
      args: { param1: 'value1' },
      isClientInitiated: false,
      prompt_id: 'prompt-id-4',
    };
    const executionErrorResult: ToolResult = {
      llmContent: 'Error: Execution failed',
      returnDisplay: 'Execution failed',
      error: {
        message: 'Execution failed',
        type: ToolErrorType.EXECUTION_FAILED,
      },
    };
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);
    mockTool.executeFn.mockReturnValue(executionErrorResult);

    const response = await executeToolCall(
      mockConfig,
      request,
      abortController.signal,
    );
    expect(response).toStrictEqual({
      callId: 'call4',
      agentId: 'primary',
      error: new Error('Execution failed'),
      errorType: ToolErrorType.EXECUTION_FAILED,
      responseParts: [
        {
          functionCall: {
            id: 'call4',
            name: 'testTool',
            args: {
              param1: 'value1',
            },
          },
        },
        {
          functionResponse: {
            id: 'call4',
            name: 'testTool',
            response: {
              output: 'Error: Execution failed',
            },
          },
        },
      ],
      resultDisplay: 'Execution failed',
    });
  });

  it('should return an unhandled exception error if execution throws', async () => {
    const request: ToolCallRequestInfo = {
      callId: 'call5',
      name: 'testTool',
      args: { param1: 'value1' },
      isClientInitiated: false,
      prompt_id: 'prompt-id-5',
    };
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);
    mockTool.executeFn.mockImplementation(() => {
      throw new Error('Something went very wrong');
    });

    const response = await executeToolCall(
      mockConfig,
      request,
      abortController.signal,
    );

    expect(response).toStrictEqual({
      callId: 'call5',
      agentId: 'primary',
      error: new Error('Something went very wrong'),
      errorType: ToolErrorType.UNHANDLED_EXCEPTION,
      resultDisplay: 'Something went very wrong',
      responseParts: [
        {
          functionCall: {
            name: 'testTool',
            id: 'call5',
            args: {
              param1: 'value1',
            },
          },
        },
        {
          functionResponse: {
            name: 'testTool',
            id: 'call5',
            response: { error: 'Something went very wrong' },
          },
        },
      ],
    });
  });

  it('should block execution when tool is disabled in settings', async () => {
    const request: ToolCallRequestInfo = {
      callId: 'call-disabled',
      name: 'testTool',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt-id-disabled',
    };
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);
    vi.mocked(mockToolRegistry.getAllTools).mockReturnValue([
      mockTool,
    ] as never[]);
    vi.mocked(mockConfig.getEphemeralSetting).mockImplementation((key) => {
      if (key === 'tools.disabled') {
        return ['testTool'];
      }
      return undefined;
    });
    vi.mocked(mockConfig.getEphemeralSettings).mockReturnValue({
      'tools.disabled': ['testTool'],
    });

    const response = await executeToolCall(
      mockConfig,
      request,
      abortController.signal,
    );

    expect(mockTool.executeFn).not.toHaveBeenCalled();
    expect(response.error).toBeInstanceOf(Error);
    expect(response.error?.message).toContain('disabled');
    expect(response.errorType).toBe(ToolErrorType.TOOL_DISABLED);
  });

  it('should correctly format llmContent with inlineData', async () => {
    const request: ToolCallRequestInfo = {
      callId: 'call6',
      name: 'testTool',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt-id-6',
    };
    const imageDataPart: Part = {
      inlineData: { mimeType: 'image/png', data: 'base64data' },
    };
    const toolResult: ToolResult = {
      llmContent: [imageDataPart],
      returnDisplay: 'Image processed',
    };
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);
    mockTool.executeFn.mockReturnValue(toolResult);

    const response = await executeToolCall(
      mockConfig,
      request,
      abortController.signal,
    );

    expect(response).toStrictEqual({
      callId: 'call6',
      agentId: 'primary',
      error: undefined,
      errorType: undefined,
      resultDisplay: 'Image processed',
      responseParts: [
        {
          functionCall: {
            name: 'testTool',
            id: 'call6',
            args: {},
          },
        },
        {
          functionResponse: {
            name: 'testTool',
            id: 'call6',
            response: {
              output: 'Binary content of type image/png was processed.',
            },
          },
        },
        imageDataPart,
      ],
    });
  });
});
