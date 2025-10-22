/**
 * @license
 * Copyright 2025 Vybestack LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import os, { EOL } from 'os';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { Config } from '../config/config.js';
import { ToolErrorType } from './tool-error.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  ToolInvocation,
  ToolResult,
  ToolExecuteConfirmationDetails,
  ToolConfirmationOutcome,
  ToolCallConfirmationDetails,
  Kind,
} from './tools.js';
import { getErrorMessage } from '../utils/errors.js';
import {
  limitOutputTokens,
  formatLimitedOutput,
} from '../utils/toolOutputLimiter.js';
import { summarizeToolOutput } from '../utils/summarizer.js';
import {
  ShellExecutionService,
  ShellOutputEvent,
} from '../services/shellExecutionService.js';
import { formatMemoryUsage } from '../utils/formatters.js';
import {
  getCommandRoots,
  isCommandAllowed,
  stripShellWrapper,
} from '../utils/shell-utils.js';

export const OUTPUT_UPDATE_INTERVAL_MS = 1000;

export interface ShellToolParams {
  /**
   * The shell command to execute
   */
  command: string;

  /**
   * Optional description of what this command does, used for confirmation prompts
   */
  description?: string;

  /**
   * Optional directory to execute the command in, relative to the target directory
   */
  directory?: string;

  /**
   * Optional number of lines to show from the beginning of output
   */
  head_lines?: number;

  /**
   * Optional number of lines to show from the end of output
   */
  tail_lines?: number;

  /**
   * Optional grep pattern to filter output lines
   */
  grep_pattern?: string;

  /**
   * Optional grep flags (e.g., -i for case-insensitive, -v for inverted)
   */
  grep_flags?: string[];
}

class ShellToolInvocation extends BaseToolInvocation<
  ShellToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: ShellToolParams,
    private readonly allowlist: Set<string>,
  ) {
    super(params);
  }

  getDescription(): string {
    let description = `${this.params.command}`;
    // append optional [in directory]
    // note description is needed even if validation fails due to absolute path
    if (this.params.directory) {
      description += ` [in ${this.params.directory}]`;
    }
    // append optional (description), replacing any line breaks with spaces
    if (this.params.description) {
      description += ` (${this.params.description.replace(/\n/g, ' ')})`;
    }
    return description;
  }

  override async shouldConfirmExecute(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    const command = stripShellWrapper(this.params.command);
    const rootCommands = [...new Set(getCommandRoots(command))];
    const commandsToConfirm = rootCommands.filter(
      (command) => !this.allowlist.has(command),
    );

    if (commandsToConfirm.length === 0) {
      return false; // already approved and allowlisted
    }

    const confirmationDetails: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Shell Command',
      command: this.params.command,
      rootCommand: commandsToConfirm.join(', '),
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          commandsToConfirm.forEach((command) => this.allowlist.add(command));
        }
      },
    };

    return confirmationDetails;
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
    terminalColumns?: number,
    terminalRows?: number,
  ): Promise<ToolResult> {
    // Validate filtering parameters
    if (this.params.head_lines) {
      validatePositiveInteger(this.params.head_lines, 'head_lines');
    }
    if (this.params.tail_lines) {
      validatePositiveInteger(this.params.tail_lines, 'tail_lines');
    }
    if (this.params.grep_pattern) {
      if (!this.params.grep_pattern.trim()) {
        throw new Error('grep_pattern cannot be empty');
      }
    }
    if (this.params.grep_flags) {
      validateGrepFlags(this.params.grep_flags);
    }

    const strippedCommand = stripShellWrapper(this.params.command);

    if (signal.aborted) {
      return {
        llmContent: 'Command was cancelled by user before it could start.',
        returnDisplay: 'Command cancelled by user.',
      };
    }

    const isWindows = os.platform() === 'win32';
    const tempFileName = `shell_pgrep_${crypto
      .randomBytes(6)
      .toString('hex')}.tmp`;
    const tempFilePath = path.join(os.tmpdir(), tempFileName);

    try {
      // pgrep is not available on Windows, so we can't get background PIDs
      const commandToExecute = isWindows
        ? strippedCommand
        : (() => {
            // wrap command to append subprocess pids (via pgrep) to temporary file
            let command = strippedCommand.trim();
            if (!command.endsWith('&')) command += ';';
            return `{ ${command} }; __code=$?; pgrep -g 0 >${tempFilePath} 2>&1; exit $__code;`;
          })();

      const cwd = path.resolve(
        this.config.getTargetDir(),
        this.params.directory || '',
      );

      let cumulativeOutput = '';
      let outputChunks: string[] = [cumulativeOutput];
      let lastUpdateTime = Date.now();
      let isBinaryStream = false;

      const executionResult = await ShellExecutionService.execute(
        commandToExecute,
        cwd,
        (event: ShellOutputEvent) => {
          if (!updateOutput) {
            return;
          }

          let currentDisplayOutput = '';
          let shouldUpdate = false;

          switch (event.type) {
            case 'data':
              if (isBinaryStream) break;
              outputChunks.push(event.chunk);
              if (Date.now() - lastUpdateTime > OUTPUT_UPDATE_INTERVAL_MS) {
                cumulativeOutput = outputChunks.join('');
                outputChunks = [cumulativeOutput];
                currentDisplayOutput = cumulativeOutput;
                shouldUpdate = true;
              }
              break;
            case 'binary_detected':
              isBinaryStream = true;
              currentDisplayOutput =
                '[Binary output detected. Halting stream...]';
              shouldUpdate = true;
              break;
            case 'binary_progress':
              isBinaryStream = true;
              currentDisplayOutput = `[Receiving binary output... ${formatMemoryUsage(
                event.bytesReceived,
              )} received]`;
              if (Date.now() - lastUpdateTime > OUTPUT_UPDATE_INTERVAL_MS) {
                shouldUpdate = true;
              }
              break;
            default: {
              throw new Error('An unhandled ShellOutputEvent was found.');
            }
          }

          if (shouldUpdate) {
            updateOutput(currentDisplayOutput);
            lastUpdateTime = Date.now();
          }
        },
        signal,
        this.config.getShouldUseNodePtyShell(),
        terminalColumns,
        terminalRows,
      );

      const result = await executionResult.result;

      const backgroundPIDs: number[] = [];
      let pgid: number | null = null;
      if (os.platform() !== 'win32' && result) {
        if (fs.existsSync(tempFilePath)) {
          const pgrepLines = fs
            .readFileSync(tempFilePath, 'utf8')
            .split(EOL)
            .filter(Boolean);
          for (const line of pgrepLines) {
            if (!/^\d+$/.test(line)) {
              console.error(`pgrep: ${line}`);
            }
            const pid = Number(line);
            if (result.pid && pid !== result.pid) {
              backgroundPIDs.push(pid);
            }
          }
        } else {
          if (!signal.aborted) {
            console.error('missing pgrep output');
          }
        }

        // Try to get the actual PGID
        try {
          const psResult = spawnSync('ps', [
            '-o',
            'pgid=',
            '-p',
            String(result.pid),
          ]);
          if (psResult.status === 0 && psResult.stdout.toString().trim()) {
            pgid = parseInt(psResult.stdout.toString().trim(), 10);
          }
        } catch (error) {
          // If we can't get the PGID, that's okay
          console.error('Failed to get PGID:', error);
        }
      }

      const rawOutput = result?.output ?? '';
      const filterInfo = applyOutputFilters(rawOutput, this.params);
      const filteredOutput = filterInfo.content;

      let llmContent = '';
      let returnDisplayMessage = '';

      if (!result) {
        llmContent = 'Command failed to execute.';
        if (this.config.getDebugMode()) {
          returnDisplayMessage = llmContent;
        }
      } else if (result.aborted) {
        llmContent = 'Command was cancelled by user before it could complete.';
        if (rawOutput && rawOutput.trim()) {
          llmContent += ` Below is the output before it was cancelled:\n${rawOutput}`;
        } else {
          llmContent += ' There was no output before it was cancelled.';
        }

        if (this.config.getDebugMode()) {
          returnDisplayMessage = llmContent;
        } else if (filteredOutput && filteredOutput.trim()) {
          returnDisplayMessage = filteredOutput;
        } else {
          returnDisplayMessage = 'Command cancelled by user.';
        }
      } else {
        const finalError = result.error
          ? result.error.message.replace(commandToExecute, this.params.command)
          : '(none)';

        llmContent = [
          `Command: ${this.params.command}`,
          `Directory: ${this.params.directory || '(root)'}`,
          `Stdout: ${filteredOutput || '(empty)'}`,
          `Stderr: ${result.stderr || '(empty)'}`,
          `Error: ${finalError}`,
          `Exit Code: ${result.exitCode ?? '(none)'}`,
          `Signal: ${result.signal ?? '(none)'}`,
          `Background PIDs: ${
            backgroundPIDs.length ? backgroundPIDs.join(', ') : '(none)'
          }`,
          `Process Group PGID: ${pgid ?? result.pid ?? '(none)'}`,
        ].join('\n');

        if (this.config.getDebugMode()) {
          returnDisplayMessage = llmContent;
        } else if (filteredOutput && filteredOutput.trim()) {
          returnDisplayMessage = filteredOutput;
        } else if (result.signal) {
          returnDisplayMessage = `Command terminated by signal: ${result.signal}`;
        } else if (result.error) {
          returnDisplayMessage = `Command failed: ${getErrorMessage(result.error)}`;
        } else if (result.exitCode !== null && result.exitCode !== 0) {
          returnDisplayMessage = `Command exited with code: ${result.exitCode}`;
        }
      }

      if (filterInfo.description && !this.config.getDebugMode()) {
        returnDisplayMessage = returnDisplayMessage
          ? `[${filterInfo.description}]\n${returnDisplayMessage}`
          : `[${filterInfo.description}]`;
      }

      // Check if summarization is configured
      const summarizeConfig = this.config.getSummarizeToolOutputConfig();
      const executionError = result?.error
        ? {
            error: {
              message: result.error.message,
              type: ToolErrorType.SHELL_EXECUTE_ERROR,
            },
          }
        : {};

      let llmPayload = llmContent;
      if (
        summarizeConfig &&
        summarizeConfig[ShellTool.Name] &&
        result &&
        !result.aborted
      ) {
        // Get the ServerToolsProvider for summarization
        const contentGenConfig = this.config.getContentGeneratorConfig();
        if (contentGenConfig?.providerManager) {
          const serverToolsProvider =
            contentGenConfig.providerManager.getServerToolsProvider();

          // If we have a ServerToolsProvider that can handle summarization
          if (serverToolsProvider) {
            // TODO: Need to adapt summarizeToolOutput to use ServerToolsProvider
            // For now, check if it's a Gemini provider and use the existing function
            if (serverToolsProvider.name === 'gemini') {
              const summary = await summarizeToolOutput(
                llmContent,
                this.config.getGeminiClient(),
                signal,
                summarizeConfig[ShellTool.Name].tokenBudget,
              );
              if (summary) {
                llmPayload = summary;
              }
            }
            // If not Gemini, we can't summarize yet - need provider-agnostic summarization
          }
        }
      }

      // ALWAYS apply token-based limiting at the end to protect the outer model
      const limitedResult = limitOutputTokens(
        llmPayload,
        this.config,
        'run_shell_command',
      );

      if (limitedResult.wasTruncated) {
        const formatted = formatLimitedOutput(limitedResult);
        return {
          llmContent: formatted.llmContent,
          returnDisplay: returnDisplayMessage,
          ...executionError,
        };
      }

      return {
        llmContent: limitedResult.content,
        returnDisplay: returnDisplayMessage,
        ...executionError,
      };
    } finally {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    }
  }
}

function applyOutputFilters(
  output: string,
  params: ShellToolParams,
): { content: string; description?: string } {
  let content = output;
  const descriptionParts: string[] = [];

  // Apply grep filter first
  if (params.grep_pattern) {
    const lines = content.split('\n');
    let filteredLines: string[];

    if (params.grep_flags?.includes('-v')) {
      // Inverted grep
      const options = params.grep_flags.includes('-i') ? 'i' : '';
      const regex = new RegExp(params.grep_pattern, options);
      filteredLines = lines.filter((line) => !regex.test(line));
    } else {
      // Normal grep
      const options = params.grep_flags?.includes('-i') ? 'i' : '';
      const regex = new RegExp(params.grep_pattern, options);
      filteredLines = lines.filter((line) => regex.test(line));
    }

    content = filteredLines.join('\n');
    descriptionParts.push(`grep_pattern filter: "${params.grep_pattern}"`);
    if (params.grep_flags?.length) {
      descriptionParts.push(`flags: [${params.grep_flags.join(', ')}]`);
    }
  }

  // Apply head_lines filter
  if (params.head_lines) {
    validatePositiveInteger(params.head_lines, 'head_lines');
    const lines = content.split('\n');
    const headLines = lines.slice(0, params.head_lines);
    const wasTruncated = lines.length > params.head_lines;

    content = headLines.join('\n');
    descriptionParts.push(
      `head_lines filter: showing first ${params.head_lines} lines${wasTruncated ? ` (of ${lines.length} total)` : ''}`,
    );
  }

  // Apply tail_lines filter
  if (params.tail_lines) {
    validatePositiveInteger(params.tail_lines, 'tail_lines');
    const lines = content.split('\n');
    const tailLines = lines.slice(-params.tail_lines);
    const wasTruncated = lines.length > params.tail_lines;

    content = tailLines.join('\n');
    descriptionParts.push(
      `tail_lines filter: showing last ${params.tail_lines} lines${wasTruncated ? ` (of ${lines.length} total)` : ''}`,
    );
  }

  return {
    content,
    description:
      descriptionParts.length > 0 ? descriptionParts.join('; ') : undefined,
  };
}

function validatePositiveInteger(value: number, paramName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${paramName} must be a positive integer, got: ${value}`);
  }
}

function validateGrepFlags(flags: string[]): void {
  const validFlags = ['-i', '-v', '-E', '-F', '-x', '-w'];
  for (const flag of flags) {
    if (!validFlags.includes(flag)) {
      throw new Error(
        `Invalid grep flag: ${flag}. Valid flags: ${validFlags.join(', ')}`,
      );
    }
  }
}

function getShellToolDescription(): string {
  const returnedInfo = `\n\n      The following information is returned:\n\n      Command: Executed command.\n      Directory: Directory (relative to project root) where command was executed, or \`(root)\`.\n      Stdout: Output on stdout stream. Can be \`(empty)\` or partial on error and for any unwaited background processes.\n      Stderr: Output on stderr stream. Can be \`(empty)\` or partial on error and for any unwaited background processes.\n      Error: Error or \`(none)\` if no error was reported for the subprocess.\n      Exit Code: Exit code or \`(none)\` if terminated by signal.\n      Signal: Signal number or \`(none)\` if no signal was received.\n      Background PIDs: List of background processes started or \`(none)\`.\n      Process Group PGID: Process group started or \`(none)\``;

  if (os.platform() === 'win32') {
    return `This tool executes a given shell command as \`cmd.exe /c <command>\`. Command can start background processes using \`start /b\`.${returnedInfo}`;
  } else {
    return `This tool executes a given shell command as \`bash -c <command>\`. Command can start background processes using \`&\`. Command is executed as a subprocess that leads its own process group. Command process group can be terminated as \`kill -- -PGID\` or signaled as \`kill -s SIGNAL -- -PGID\`.${returnedInfo}`;
  }
}

function getCommandDescription(): string {
  if (os.platform() === 'win32') {
    return 'Exact command to execute as `cmd.exe /c <command>`';
  } else {
    return 'Exact bash command to execute as `bash -c <command>`';
  }
}

export class ShellTool extends BaseDeclarativeTool<
  ShellToolParams,
  ToolResult
> {
  static Name: string = 'run_shell_command';
  private allowlist: Set<string> = new Set();

  constructor(private readonly config: Config) {
    super(
      ShellTool.Name,
      'Shell',
      getShellToolDescription(),
      Kind.Execute,
      {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: getCommandDescription(),
          },
          description: {
            type: 'string',
            description:
              'Brief description of the command for the user. Be specific and concise. Ideally a single sentence. Can be up to 3 sentences for clarity. No line breaks.',
          },
          directory: {
            type: 'string',
            description:
              '(OPTIONAL) Directory to run the command in, if not the project root directory. Must be relative to the project root directory and must already exist.',
          },
        },
        required: ['command'],
      },
      false, // output is not markdown
      true, // output can be updated
    );
  }

  protected override validateToolParamValues(
    params: ShellToolParams,
  ): string | null {
    const commandCheck = isCommandAllowed(params.command, this.config);
    if (!commandCheck.allowed) {
      if (!commandCheck.reason) {
        console.error(
          'Unexpected: isCommandAllowed returned false without a reason',
        );
        return `Command is not allowed: ${params.command}`;
      }
      return commandCheck.reason;
    }
    if (!params.command.trim()) {
      return 'Command cannot be empty.';
    }
    if (getCommandRoots(params.command).length === 0) {
      return 'Could not identify command root to obtain permission from user.';
    }
    if (params.directory) {
      if (path.isAbsolute(params.directory)) {
        return 'Directory cannot be absolute. Please refer to workspace directories by their name.';
      }
      const workspaceDirs = this.config.getWorkspaceContext().getDirectories();
      const matchingDirs = workspaceDirs.filter(
        (dir) => path.basename(dir) === params.directory,
      );

      if (matchingDirs.length === 0) {
        return `Directory '${params.directory}' is not a registered workspace directory.`;
      }

      if (matchingDirs.length > 1) {
        return `Directory name '${params.directory}' is ambiguous as it matches multiple workspace directories.`;
      }
    }
    return null;
  }

  protected createInvocation(
    params: ShellToolParams,
  ): ToolInvocation<ShellToolParams, ToolResult> {
    return new ShellToolInvocation(this.config, params, this.allowlist);
  }
}
