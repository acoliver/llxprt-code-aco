/**
 * @license
 * Copyright 2025 Vybestack LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Config,
  ToolCallRequestInfo,
  executeToolCall,
  shutdownTelemetry,
  isTelemetrySdkInitialized,
  GeminiEventType,
  parseAndFormatApiError,
  FatalInputError,
  FatalTurnLimitedError,
  EmojiFilter,
  type EmojiFilterMode,
} from '@vybestack/llxprt-code-core';
import { Content, Part } from '@google/genai';

import { ConsolePatcher } from './ui/utils/ConsolePatcher.js';
import { handleAtCommand } from './ui/hooks/atCommandProcessor.js';

export async function runNonInteractive(
  config: Config,
  input: string,
  prompt_id: string,
): Promise<void> {
  const consolePatcher = new ConsolePatcher({
    stderr: true,
    debugMode: config.getDebugMode(),
  });

  try {
    consolePatcher.patch();
    // Handle EPIPE errors when the output is piped to a command that closes early.
    process.stdout.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') {
        // Exit gracefully if the pipe is closed.
        process.exit(0);
      }
    });

    const geminiClient = config.getGeminiClient();

    // Initialize emoji filter for non-interactive mode
    const emojiFilterMode =
      typeof config.getEphemeralSetting === 'function'
        ? (config.getEphemeralSetting('emojifilter') as EmojiFilterMode) ||
          'auto'
        : 'auto';
    const emojiFilter =
      emojiFilterMode !== 'allowed'
        ? new EmojiFilter({ mode: emojiFilterMode })
        : undefined;

    const abortController = new AbortController();

    const { processedQuery, shouldProceed } = await handleAtCommand({
      query: input,
      config,
      addItem: (_item, _timestamp) => 0,
      onDebugMessage: () => {},
      messageId: Date.now(),
      signal: abortController.signal,
    });

    if (!shouldProceed || !processedQuery) {
      // An error occurred during @include processing (e.g., file not found).
      // The error message is already logged by handleAtCommand.
      throw new FatalInputError(
        'Exiting due to an error processing the @ command.',
      );
    }

    let currentMessages: Content[] = [
      { role: 'user', parts: processedQuery as Part[] },
    ];

    let turnCount = 0;
    while (true) {
      turnCount++;
      if (
        config.getMaxSessionTurns() >= 0 &&
        turnCount > config.getMaxSessionTurns()
      ) {
        throw new FatalTurnLimitedError(
          'Reached max session turns for this session. Increase the number of turns by specifying maxSessionTurns in settings.json.',
        );
      }
      const functionCalls: ToolCallRequestInfo[] = [];

      const responseStream = geminiClient.sendMessageStream(
        currentMessages[0]?.parts || [],
        abortController.signal,
        prompt_id,
      );

      for await (const event of responseStream) {
        if (abortController.signal.aborted) {
          console.error('Operation cancelled.');
          return;
        }

        if (event.type === GeminiEventType.Content) {
          // Apply emoji filtering to content output
          let outputValue = event.value;
          if (emojiFilter) {
            const filterResult = emojiFilter.filterStreamChunk(event.value);

            if (filterResult.blocked) {
              // In error mode: output error message and continue
              process.stderr.write(
                '[Error: Response blocked due to emoji detection]\n',
              );
              continue;
            }

            outputValue =
              typeof filterResult.filtered === 'string'
                ? (filterResult.filtered as string)
                : '';

            // Output system feedback if needed
            if (filterResult.systemFeedback) {
              process.stderr.write(`Warning: ${filterResult.systemFeedback}\n`);
            }
          }

          process.stdout.write(outputValue);
        } else if (event.type === GeminiEventType.ToolCallRequest) {
          const toolCallRequest = event.value;
          const normalizedRequest: ToolCallRequestInfo = {
            ...toolCallRequest,
            agentId: toolCallRequest.agentId ?? 'primary',
          };
          functionCalls.push(normalizedRequest);
        }
      }

      const remainingBuffered = emojiFilter?.flushBuffer?.();
      if (remainingBuffered) {
        process.stdout.write(remainingBuffered);
      }

      if (functionCalls.length > 0) {
        const toolResponseParts: Part[] = [];

        for (const requestFromModel of functionCalls) {
          const callId =
            requestFromModel.callId ?? `${requestFromModel.name}-${Date.now()}`;
          const rawArgs = requestFromModel.args ?? {};
          let normalizedArgs: Record<string, unknown>;
          if (typeof rawArgs === 'string') {
            try {
              const parsed = JSON.parse(rawArgs);
              normalizedArgs =
                parsed && typeof parsed === 'object'
                  ? (parsed as Record<string, unknown>)
                  : {};
            } catch (error) {
              console.error(
                `Failed to parse tool arguments for ${requestFromModel.name}: ${error instanceof Error ? error.message : String(error)}`,
              );
              normalizedArgs = {};
            }
          } else if (Array.isArray(rawArgs)) {
            console.error(
              `Unexpected array arguments for tool ${requestFromModel.name}; coercing to empty object.`,
            );
            normalizedArgs = {};
          } else if (rawArgs && typeof rawArgs === 'object') {
            normalizedArgs = rawArgs as Record<string, unknown>;
          } else {
            normalizedArgs = {};
          }

          const requestInfo: ToolCallRequestInfo = {
            callId,
            name: requestFromModel.name,
            args: normalizedArgs,
            isClientInitiated: false,
            prompt_id: requestFromModel.prompt_id ?? prompt_id,
            agentId: requestFromModel.agentId ?? 'primary',
          };

          const toolResponse = await executeToolCall(
            config,
            requestInfo,
            abortController.signal,
          );

          if (toolResponse.error) {
            console.error(
              `Error executing tool ${requestFromModel.name}: ${toolResponse.resultDisplay || toolResponse.error.message}`,
            );
          }

          if (toolResponse.responseParts) {
            toolResponseParts.push(...toolResponse.responseParts);
          }
        }
        currentMessages = [{ role: 'user', parts: toolResponseParts }];
      } else {
        process.stdout.write('\n'); // Ensure a final newline
        return;
      }
    }
  } catch (error) {
    console.error(
      parseAndFormatApiError(
        error,
        config.getContentGeneratorConfig()?.authType,
      ),
    );
    throw error;
  } finally {
    consolePatcher.cleanup();
    if (isTelemetrySdkInitialized()) {
      await shutdownTelemetry(config);
    }
  }
}
