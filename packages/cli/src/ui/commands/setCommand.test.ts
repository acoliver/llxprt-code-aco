/**
 * @license
 * Copyright 2025 Vybestack LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { CommandContext } from './types.js';
import { setCommand } from './setCommand.js';

const mockRuntime = {
  getActiveModelParams: vi.fn(() => ({})),
  getEphemeralSettings: vi.fn(() => ({})),
  setEphemeralSetting: vi.fn(),
  setActiveModelParam: vi.fn(),
  clearActiveModelParam: vi.fn(),
};

vi.mock('../contexts/RuntimeContext.js', () => ({
  getRuntimeApi: () => mockRuntime,
}));

describe('setCommand runtime integration', () => {
  let context: CommandContext;

  beforeEach(() => {
    context = createMockCommandContext();
    vi.clearAllMocks();
  });

  it('requires arguments and shows usage when missing', async () => {
    const result = await setCommand.action!(context, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        'Usage: /set <ephemeral-key> <value>\nExample: /set context-limit 100000\n\nFor model parameters use: /set modelparam <key> <value>',
    });
  });

  it('stores numeric ephemeral settings via runtime helper', async () => {
    const result = await setCommand.action!(context, 'context-limit 32000');

    expect(mockRuntime.setEphemeralSetting).toHaveBeenCalledWith(
      'context-limit',
      32000,
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        "Ephemeral setting 'context-limit' set to 32000 (session only, use /profile save to persist)",
    });
  });

  it('parses JSON payloads for custom headers', async () => {
    const payload =
      'custom-headers {"Authorization":"Bearer token","X-Test":"value"}';
    const result = await setCommand.action!(context, payload);

    expect(mockRuntime.setEphemeralSetting).toHaveBeenCalledWith(
      'custom-headers',
      expect.objectContaining({
        Authorization: 'Bearer token',
        'X-Test': 'value',
      }),
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Ephemeral setting \'custom-headers\' set to {"Authorization":"Bearer token","X-Test":"value"} (session only, use /profile save to persist)',
    });
  });

  it('rejects invalid ephemeral keys', async () => {
    const result = await setCommand.action!(context, 'invalid-key value');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        'Invalid setting key: invalid-key. Valid keys are: context-limit, compression-threshold, base-url, tool-format, api-version, custom-headers, stream-options, streaming, shell-replacement, socket-timeout, socket-keepalive, socket-nodelay, tool-output-max-items, tool-output-max-tokens, tool-output-truncate-mode, tool-output-item-size-limit, max-prompt-tokens, emojifilter, retries, retrywait, maxTurnsPerPrompt',
    });
  });

  it('validates compression threshold range', async () => {
    const result = await setCommand.action!(
      context,
      'compression-threshold 1.5',
    );

    expect(mockRuntime.setEphemeralSetting).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        'compression-threshold must be a decimal between 0 and 1 (e.g., 0.7 for 70%)',
    });
  });

  it('sets model parameters through runtime helper', async () => {
    const result = await setCommand.action!(
      context,
      'modelparam temperature 0.7',
    );

    expect(mockRuntime.setActiveModelParam).toHaveBeenCalledWith(
      'temperature',
      0.7,
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: "Model parameter 'temperature' set to 0.7",
    });
  });

  it('requires both key and value for modelparam', async () => {
    const result = await setCommand.action!(context, 'modelparam temperature');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        'Usage: /set modelparam <key> <value>\nExample: /set modelparam temperature 0.7',
    });
    expect(mockRuntime.setActiveModelParam).not.toHaveBeenCalled();
  });

  it('surfaces runtime errors from model parameter helper', async () => {
    mockRuntime.setActiveModelParam.mockImplementationOnce(() => {
      throw new Error('Provider error');
    });

    const result = await setCommand.action!(
      context,
      'modelparam max_tokens 4096',
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Failed to set model parameter: Provider error',
    });
  });

  it('clears ephemeral settings via unset', async () => {
    const result = await setCommand.action!(context, 'unset base-url');

    expect(mockRuntime.setEphemeralSetting).toHaveBeenCalledWith(
      'base-url',
      undefined,
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: "Ephemeral setting 'base-url' cleared",
    });
  });

  it('clears model parameters via unset modelparam', async () => {
    const result = await setCommand.action!(
      context,
      'unset modelparam temperature',
    );

    expect(mockRuntime.clearActiveModelParam).toHaveBeenCalledWith(
      'temperature',
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: "Model parameter 'temperature' cleared",
    });
  });

  it('requires model parameter name when clearing modelparam', async () => {
    const result = await setCommand.action!(context, 'unset modelparam');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        'Usage: /set unset modelparam <key>\nExample: /set unset modelparam temperature',
    });
    expect(mockRuntime.clearActiveModelParam).not.toHaveBeenCalled();
  });

  it('handles nested custom header removal when header exists', async () => {
    mockRuntime.getEphemeralSettings.mockReturnValueOnce({
      'custom-headers': {
        Authorization: 'Bearer token',
        'X-Test': 'value',
      },
    });

    const result = await setCommand.action!(
      context,
      'unset custom-headers Authorization',
    );

    expect(mockRuntime.setEphemeralSetting).toHaveBeenCalledWith(
      'custom-headers',
      {
        'X-Test': 'value',
      },
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: "Custom header 'Authorization' cleared",
    });
  });

  it('returns informational message when nested custom header missing', async () => {
    mockRuntime.getEphemeralSettings.mockReturnValueOnce({
      'custom-headers': {},
    });

    const result = await setCommand.action!(
      context,
      'unset custom-headers Authorization',
    );

    expect(mockRuntime.setEphemeralSetting).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: "No custom header named 'Authorization' found",
    });
  });
});
